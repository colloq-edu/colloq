/**
 * The admin surface: the teaching side of Colloq.
 *
 * Students never touch anything in this file. They open a seminar link, type a
 * name and are in — that stays true. This is the other half: who may create a
 * seminar, which model answers questions, and who holds the key that pays for
 * it.
 *
 * AUTHENTICATION, and why it looks like this
 * ------------------------------------------
 * There is no password, no email delivery and no SSO, because a self-hosted
 * seminar tool cannot assume an SMTP relay or a university IdP — and a product
 * whose entire premise is "a link is enough" has no business growing a login
 * form for the ten people on the other side of it.
 *
 * Two credentials, both links, both revocable:
 *
 *   1. THE SETUP TOKEN. Written to <DATA_DIR>/setup-token (0600) on first boot
 *      and printed once to the server log, exactly like Jupyter's. Whoever can
 *      read the server's disk owns the instance — that is already true of any
 *      self-hosted service, so it is stated rather than pretended away. It does
 *      not expire: it is also the recovery path when the owner loses their link.
 *
 *   2. A PERSONAL SIGN-IN LINK per teacher. Bookmarkable, rotatable, and it
 *      dies with the account. The owner copies one and sends it however they
 *      already talk to that colleague.
 *
 * Both exchange themselves for an HttpOnly cookie; the link itself is never
 * what authorises a request.
 */

/* ------------------------------------------------------------------ people */

/**
 * `owner` may add and remove teachers and rotate their links; `teacher` may run
 * seminars and read settings. Exactly one owner is guaranteed to exist at all
 * times — the last one cannot be demoted or removed, because an instance with
 * nobody who can grant access is an instance that has to be recovered from the
 * setup token.
 */
import type { RoomRules } from './rules.js'

export type AdminRole = 'owner' | 'teacher'

export interface InstanceSettings {
  language: import('./i18n-types.js').Locale
}

export interface Teacher {
  id: string
  /** Identity, not a delivery channel: nothing is ever sent here. */
  email: string
  name: string
  role: AdminRole
  createdAt: number
  /** null until they have signed in once. */
  lastSeenAt: number | null
  /** True once a sign-in link exists. The link itself is never in a list response. */
  hasLink: boolean
}

/** Returned only at the moment a link is minted or rotated, and never again. */
export interface TeacherWithLink {
  teacher: Teacher
  /** Absolute URL, ready to paste into a chat. */
  signInUrl: string
}

export interface AdminMe {
  teacher: Teacher
  /** How many owners exist, so the UI can refuse to strand the instance. */
  ownerCount: number
}

/* ------------------------------------------------------------ instance state */

/**
 * What an unauthenticated caller may know. Deliberately thin: it says whether
 * the instance has an owner yet, and nothing about who they are.
 */
export interface InstanceState {
  /** False on a fresh install: the setup token is the only way in. */
  claimed: boolean
  /** Prefill for the claim form, from ADMIN_EMAIL. Empty when unset. */
  suggestedEmail: string
  /** Whether POST /api/sessions accepts a caller who is not staff. No page uses it. */
  openSeminarCreation: boolean
  /**
   * Сколько байт принимает загрузка файла — `MAX_UPLOAD_MB` сервера.
   *
   * Число здесь, потому что его печатает форма создания семинара («Up to 50 MB
   * each») и по нему же она отказывает файлу ДО того, как комната создана. До
   * этого поля панель держала собственную копию умолчания, и оператор,
   * поднявший предел до 200 или опустивший до 20, читал на экране чужое число,
   * а узнавал правду загрузкой, которая не доехала.
   *
   * Необязательное: сборка постарше его не присылает, и тогда экран о пределе
   * молчит, а не выдумывает его.
   */
  maxUploadBytes?: number
}

export interface ClaimRequest {
  /** The token from <DATA_DIR>/setup-token, or the first-boot log line. */
  token: string
  name: string
  email: string
}

export interface SignInWithTokenRequest {
  token: string
}

/* --------------------------------------------------------------- seminars */

/**
 * В каком состоянии семинар — одним словом, для строки списка.
 *
 * Три из них про то, что происходит само: `live` — в комнате кто-то есть
 * прямо сейчас, `draft` — ссылку ещё никому не давали (не заходил никто), `idle`
 * — заходили, а сейчас пусто. Четвёртое — решение преподавателя: `finished`
 * значит, что занятие закончено и в комнате теперь только читают.
 *
 * Решение сильнее подсчёта: у законченного занятия статус `finished`, даже
 * если полкласса сидит и перечитывает разбор. Иначе выходила бессмыслица —
 * пустая комната и законченное занятие показывались одним и тем же словом, и
 * звонок ничего в списке не менял.
 */
export type SeminarStatus = 'draft' | 'live' | 'idle' | 'finished'

export interface AdminSeminar {
  id: string
  name: string
  createdAt: number
  status: SeminarStatus
  /** People currently connected, not people who ever joined. */
  liveCount: number
  /**
   * Когда открылся самый старый из сокетов, которые сейчас в комнате, — то
   * есть с какого момента идёт то занятие, что идёт прямо сейчас. `null`, если
   * в комнате никого.
   *
   * Отдельные часы от `createdAt`, и именно потому, что это разные часы:
   * комнату заводят за неделю до пары и переиспользуют на второй, а баннер
   * «Running now · started 6 days ago» читается как длительность занятия.
   * Необязательное: сборка постарше поля не присылает, и панель тогда называет
   * своими именами те часы, которые у неё есть.
   */
  liveSince?: number | null
  /** Everyone who has ever joined, which is what "24 people" means on a card. */
  totalParticipants: number
  cellCount: number
  fileCount: number
  /** Absolute seminar URL, so the list can offer copy without a second call. */
  url: string
  /** Who created it; null for seminars made before there was an admin panel. */
  createdBy: string | null
  /**
   * The environment this room's kernel is actually on, or null when it has not
   * started one yet. Not the configured environment: a seminar that was live
   * through a switch keeps the image it came up on until its kernel restarts.
   */
  environment: string | null
  archivedAt: number | null
  /**
   * Что комната разрешает. Нужно списку, чтобы можно было менять правила
   * существующего семинара, а не только задать их при создании.
   */
  rules: RoomRules
  /**
   * Публичная страница этого семинара, если она есть.
   *
   * `slug` — заданное имя в адресе; `null` значит, что адресом остаётся
   * идентификатор. Список печатает и копирует `/p/<slug ?? id>`: заданное имя
   * и есть тот адрес, который дали классу, а идентификатор рядом с ним читался
   * бы как второй, чужой.
   */
  publication: {
    id: string
    slug: string | null
    state: 'published' | 'withdrawn'
    steps: number
  } | null
  /** Курсы, в которых он состоит. Обычно один, но запрета на два нет. */
  courses: { id: string; name: string }[]
  /**
   * Когда преподаватель закончил занятие — или null, пока оно идёт.
   *
   * Время, которого нет в `status: 'finished'` рядом: слово говорит, что
   * занятие закончено, а час — когда именно, и он-то и нужен тому, кто
   * вернулся в комнату через день.
   */
  finishedAt: number | null
  /**
   * Сколько памяти выдано ядру этой комнаты, в мегабайтах, — или null, если ей
   * ничего не задавали и она живёт умолчанием своего окружения.
   *
   * Своё число, а не действующее: в настройках человек обязан отличать «я
   * поставил четыре гигабайта» от «столько даёт окружение». Умолчание панель
   * знает отдельно — из /api/instance/resources, оно одно на все комнаты и
   * меняется без них. Необязательное: сборка сервера постарше поля не
   * присылает, и тогда раздел «Ресурсы» просто молчит.
   */
  memoryMb?: number | null
  /** Сколько ядер задано этой комнате, или null — умолчание инстанса. */
  cpus?: number | null
}

export interface CreateSeminarRequest {
  name: string
  /**
   * Which environment this room's Python should be. Omitted or null means
   * whatever the instance runs, which is what every seminar got before this
   * existed. Chosen once and then fixed: a room whose packages change under it
   * mid-class is worse than one that never had the newest ones.
   */
  environment?: string | null
  /**
   * Какое это занятие: лаборатория, где работают все, или лекция, где тетрадь
   * преподавательская целиком.
   *
   * Режим — это ПРЕСЕТ правил, а не отдельное состояние комнаты: 'lecture'
   * записывает `LECTURE_ROOM`, 'lab' — `OPEN_ROOM`, и дальше комната живёт
   * одними правилами. Иначе в продукте появилось бы два источника правды о
   * том, что в комнате можно, и они разъехались бы на первом же переключателе
   * в настройках: правило говорит одно, режим — другое, а сервер спрашивает
   * только одного из них.
   *
   * Нет поля — 'lab', то есть ровно сегодняшнее поведение: семинар, созданный
   * скриптом или сборкой постарше, открывается тем же, чем открывался.
   */
  mode?: 'lab' | 'lecture' | 'council'
  /**
   * How the room will run: who may do what, and what its oracle does.
   *
   * Optional, and absent means the open room the product has always been —
   * `OPEN_ROOM` in shared/rules.ts. Only the fields the server can actually
   * keep have any effect; the rest are stored so that the day they become
   * enforceable, the seminars created today already say what they wanted.
   *
   * Приехав вместе с `mode`, ложится ПОВЕРХ его пресета: человек выбрал режим
   * и подкрутил в нём одну строку, и подкрученное сильнее выбранного.
   */
  rules?: Partial<RoomRules>
  /**
   * Сколько памяти дать ядру этой комнаты, в мегабайтах.
   *
   * Опущено или null — умолчание окружения (`KERNEL_MEM` и пул). Задаётся
   * здесь, а не в отдельном походе в настройки утром: занятие по зрению
   * заводят накануне, и «шесть гигабайт» — такое же решение о комнате, как
   * выбор окружения рядом.
   */
  memoryMb?: number | null
  /** Сколько ядер дать комнате; опущено или null — умолчание инстанса. */
  cpus?: number | null
}

export interface UpdateSeminarRequest {
  name?: string
  archived?: boolean
  /**
   * Закончить занятие или открыть его снова — из панели.
   *
   * Та же дверь, что кнопка в комнате: преподаватель, закрывший вкладку и
   * вспомнивший про это в метро, не должен возвращаться в комнату ради одного
   * нажатия.
   */
  finished?: boolean
  /**
   * Правила комнаты. Накладываются на текущие, а не заменяют их.
   *
   * Раньше правила задавались один раз, при создании, и преподаватель, решивший
   * закрыть прошлонедельную комнату, не мог ничего — приходилось заводить
   * вторую.
   */
  rules?: Partial<RoomRules>
  /**
   * Новый лимит памяти комнаты в мегабайтах; null возвращает её к умолчанию
   * окружения.
   *
   * Применяется к ЖИВОЙ комнате сразу, без перезапуска ядра (`docker update`):
   * преподаватель, чьё ядро только что убили по памяти, добавляет гигабайты и
   * запускает ту же ячейку заново, не потеряв ни переменных семинара, ни
   * открытого терминала.
   */
  memoryMb?: number | null
  /**
   * Сколько ядер дать комнате; null возвращает её к умолчанию инстанса.
   *
   * Живому контейнеру применяется сразу (`docker update --cpus`), но потоки
   * numpy и torch внутри уже запущенного ядра остаются прежними: их число
   * считается один раз, при старте интерпретатора. Об этом сказано в форме.
   */
  cpus?: number | null
}

/* ----------------------------------------------------------- ресурсы */

/** Карта машины: имя и вся её видеопамять. Комнаты делят её и cgroup её не режет. */
export interface GpuCard {
  index: number
  name: string
  memoryMb: number
}

/** Комната в списке «кто держит память машины». */
export interface RoomResource {
  id: string
  name: string
  /** Действующий лимит: своё число комнаты, иначе умолчание её окружения. */
  memoryMb: number
  /** Сколько ядер у комнаты: своё число, иначе умолчание инстанса. */
  cpus: number
  environment: string | null
  alive: boolean
}

/**
 * Чем располагает машина под инстансом.
 *
 * Нужно ровно одному экрану — форме занятия, — и ровно затем, чтобы поле
 * «сколько памяти» не было гаданием: 13.09 ядро семинара убили по памяти
 * шестнадцать раз подряд, и числа, по которым это можно было предвидеть,
 * знал только тот, у кого есть ssh.
 */
export interface InstanceResources {
  memory: {
    totalMb: number
    /**
     * Сколько ещё можно раздать комнатам; `null` — «не знаем».
     *
     * Не знаем там, где число было бы выдумкой: у macOS нет MemAvailable, а
     * `os.freemem()` там считает свободной только память, не занятую ничем, и
     * на Маке с 36 ГБ выдавал «свободно 0,5». Пугать таким числом хуже, чем
     * промолчать, поэтому форма про свободное тогда не говорит вовсе.
     */
    availableMb: number | null
    /**
     * Чьи это числа: машины сервера или демона docker.
     *
     * Под колимой и Docker Desktop контейнеры живут в виртуалке со своей
     * памятью, и потолок комнаты ставит она, а не Мак. Форма обязана называть
     * вещи своими именами: «в Docker 11,7 ГБ» вместо «на машине 36».
     */
    source: 'host' | 'docker'
  }
  cpus: number
  gpus: GpuCard[]
  kernel: {
    defaultMemoryMb: number
    gpuDefaultMemoryMb: number
    /** Ядра комнате по умолчанию — `KERNEL_CPUS`, одно число на инстанс. */
    defaultCpus: number
    /** Что получит комната на этом окружении, если ей ничего не задали. */
    perEnvironment: Record<string, { memoryMb: number; gpu: boolean }>
  }
  rooms: RoomResource[]
  /**
   * Границы, в которых сервер примет число: мегабайты — полем, ядра — своим.
   * Считает их он, а не форма: вторая копия правила в браузере разошлась бы с
   * серверной на первом же её изменении.
   */
  limits: { min: number; max: number; cpus: { min: number; max: number } }
}

/* -------------------------------------------------------------- oracle */

/**
 * Presets only change which base URL and model are suggested — every one of
 * them speaks the same OpenAI HTTP shape, which is the whole reason the
 * oracle is portable.
 */
export type AiProviderId = 'openai' | 'ollama' | 'vllm' | 'openrouter' | 'custom'

/** What a seminar's oracle is allowed to do. A seminar may lower this, never raise it. */
export type OracleMode = 'off' | 'hints' | 'full'

export interface OracleSettings {
  provider: AiProviderId
  baseUrl: string
  model: string
  /** Masked for display, e.g. 'sk-…8fA2'. The key itself never leaves the server. */
  apiKeyMasked: string | null
  defaultMode: OracleMode
  /** Appended to the system prompt. This is where a teacher fences off a library. */
  houseRules: string
  /** Per student, per seminar, per hour. 0 disables the oracle outright. */
  questionsPerHour: number
  /**
   * Сколько секунд между двумя вопросами одного человека. 0 — выключено.
   *
   * Не то же самое, что потолок в час, и заводится рядом именно поэтому:
   * двадцать вопросов можно выкрикнуть за двадцать секунд, и потолок накажет
   * не спам, а следующий настоящий вопрос — через час. Промежуток стоит там,
   * где спам, и стоит секунды.
   */
  slowModeSeconds: number
  /** Ceiling on the notebook text sent as context. */
  contextChars: number
  /** Tool actions per Do request; 0 means unlimited. */
  agentSteps: number
  /** Whether the environment supplied a key, in which case the UI must not
   *  claim the instance is unconfigured while OPENAI_API_KEY is doing the job. */
  keyFromEnvironment: boolean
}

export interface UpdateOracleRequest {
  provider?: AiProviderId
  baseUrl?: string
  model?: string
  /** Send the new secret to replace it, '' to clear it, omit to leave it alone. */
  apiKey?: string
  defaultMode?: OracleMode
  houseRules?: string
  questionsPerHour?: number
  slowModeSeconds?: number
  contextChars?: number
  agentSteps?: number
}

export interface OracleTestResult {
  ok: boolean
  /** Round trip in ms when ok. */
  ms: number | null
  /** A sentence a teacher standing in front of a class can act on. */
  message: string
  /** What the endpoint said its model was, when it says so. */
  model: string | null
}

/**
 * Counted on our own server rather than read from the provider, so it reflects
 * what the room did. Cost is deliberately absent: it would mean shipping a
 * price table per provider that goes stale silently, and a wrong number about
 * money is worse than no number.
 */
export interface OracleUsage {
  since: number
  questions: number
  /** Reported by the provider when it reports usage at all; null otherwise. */
  tokens: number | null
  byAction: Record<string, number>
  seminarsWithQuestions: number
}

/* ------------------------------------------------------------------ limits */

export const LIMITS = {
  teacherName: 60,
  email: 160,
  seminarName: 80,
  houseRules: 1000,
  baseUrl: 300,
  model: 120,
  /** Per student, per seminar, per hour. */
  questionsPerHour: { min: 0, max: 500, default: 20 },
  /**
   * Промежуток между вопросами одного человека, в секундах.
   *
   * По умолчанию ноль: слоу-мод — это ответ на конкретный класс, а не общее
   * правило, и включать его молча всем значит замедлить те комнаты, где никто
   * не спамил. Потолок в пять минут — уже не «не частите», а «сегодня без
   * оракула»; дальше этого настройка не даёт зайти по ошибке.
   */
  slowModeSeconds: { min: 0, max: 300, default: 0 },
  contextChars: { min: 2_000, max: 100_000, default: 20_000 },
  /**
   * Сколько действий оракул делает за один ход в режиме «сделать».
   *
   * Ноль по-прежнему значит «без предела» — это выбор оператора, и отнимать
   * его нельзя. Но умолчанием он быть перестал: ход без потолка, упёршийся в
   * модель, которая описывает вызов прозой вместо того, чтобы его сделать,
   * ходит к провайдеру, пока кто-нибудь не нажмёт «Стоп» — и платит за это
   * владелец ключа. Двадцать четыре — это «посмотреть, прочитать, завести
   * тетрадь, набросать десяток ячеек, запустить пару» с запасом: настоящая
   * работа в него укладывается, бесконечный круг — нет.
   */
  agentSteps: { min: 0, max: 10_000, default: 24 },
} as const

export const PROVIDER_PRESETS: Record<
  AiProviderId,
  { label: string; baseUrl: string; model: string }
> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { label: 'Ollama', baseUrl: 'http://host.docker.internal:11434/v1', model: 'llama3.1' },
  vllm: { label: 'vLLM', baseUrl: 'http://host.docker.internal:8000/v1', model: '' },
  /*
   * OpenRouter namespaces its models by vendor: `gpt-4o-mini` is not a model
   * there, `openai/gpt-4o-mini` is. Leaving this empty meant switching from
   * OpenAI kept `gpt-4o-mini` in the field — a name that looks right, is
   * plausible, and fails at the provider with a message about an unknown model.
   */
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
  },
  custom: { label: 'Custom', baseUrl: '', model: '' },
}

/**
 * Провайдеры, чей рантайм ключа не знает вовсе.
 *
 * Ollama и vLLM поднимают у себя OpenAI-совместимый эндпойнт и на заголовок
 * авторизации не смотрят: спрашивать у преподавателя ключ к его собственной
 * машине — значит просить секрет, которого не существует.
 */
export const KEYLESS_PROVIDERS: readonly AiProviderId[] = ['ollama', 'vllm']

export function isKeylessProvider(provider: AiProviderId): boolean {
  return KEYLESS_PROVIDERS.includes(provider)
}

/**
 * Есть ли на этом инстансе, кого спрашивать: ключ ЛИБО локальный рантайм с
 * адресом.
 *
 * Единственная копия правила. Раньше их было две, и они разошлись: сервер
 * пускает вопрос по `providerReady()` (ai/provider.ts — «ключ, или рантайм, у
 * которого понятия ключа нет»), а панель считала потолок комнаты по одному
 * ключу и на настроенной Ollama гасила «Hints only» и «Full answers» с
 * подписью «на инстансе нет ключа». Оракул при этом отвечал — экран отбирал у
 * преподавателя настройку, которая работала.
 *
 * `hasKey` отдельным полем потому, что сам ключ на клиент не уезжает: сервер
 * знает строку, панель — только маску и «ключ пришёл из окружения».
 */
export function providerConfigured(cfg: {
  provider: AiProviderId
  baseUrl: string
  hasKey: boolean
}): boolean {
  if (cfg.hasKey) return true
  // Хвостовой слеш сервер срезает при чтении настроек (resolveAiConfig), так
  // что '/' — это не адрес; здесь то же самое, иначе две стороны разойдутся.
  return isKeylessProvider(cfg.provider) && cfg.baseUrl.trim().replace(/\/+$/, '').length > 0
}

/* --------------------------------------------------------------- transport */

/**
 * The cookie is HttpOnly and SameSite=Lax and is the ONLY thing that authorises
 * an admin request: a sign-in link is spent once and exchanged for it.
 */
export const STAFF_COOKIE = 'colloq_staff'

/** Where a personal sign-in link points. The page exchanges :key for the cookie. */
export const SIGN_IN_PATH = '/admin/k/'

/**
 * Every /api/admin route answers one of these on failure, so the client has a
 * single branch for "you are not signed in" and can send the user to /admin.
 */
/**
 * Why a request was refused, in a word the client can branch on.
 *
 * `error` is what a person reads; this is what the code reacts to. The first
 * four are about who is asking. The rest are about environments, where the
 * panel does react differently: a build already running is a reason to watch
 * the log rather than show a failure, and a missing Docker socket is a reason
 * to explain the `make` command instead of retrying.
 */
export type AdminErrorReason =
  | 'unauthenticated'
  | 'forbidden'
  | 'unclaimed'
  | 'invalid'
  | 'not_found'
  | 'too_long'
  /** The environment is the one the room is running, or is `base`. */
  | 'in_use'
  | 'protected'
  /** Создать под именем, которое уже занято: правка — это другой запрос. */
  | 'exists'
  /**
   * This install cannot do that here: no Docker, no build context, or — for the
   * default — no .env, which stays on the host. The message says which.
   */
  | 'no_docker'
  | 'managed_environment'
  | 'building'
  | 'failed'
  /**
   * Запрос не доехал: сервера нет, сети нет, туннель закрыт.
   *
   * Не от сервера — его сочиняет клиент, когда fetch отверг обещание. Отдельно
   * от 'invalid', потому что «попробуйте ещё раз» здесь осмысленно, а там нет.
   */
  | 'network'

export interface AdminErrorBody {
  error: string
  reason: AdminErrorReason
}

/* --------------------------------------------------------- environments */

/**
 * What a seminar's Python is made of.
 *
 * An environment is a list of packages that gets baked into a container image
 * on top of the base every kernel has. The panel calls them environments; on
 * disk each one is `kernel/environments/<name>.txt`, and in Docker each is the
 * image tag `colloq-kernel:<name>`.
 */
export type EnvironmentState =
  /** Built and ready — a seminar switched to it starts in seconds. */
  | 'ready'
  /** Written down but never built, or edited since the last build. */
  | 'unbuilt'
  | 'building'
  | 'failed'

export interface AdminEnvironment {
  /** Operator-published immutable image catalog, not an editable local build. */
  managed?: boolean
  image?: string
  revision?: string
  /** Also the filename and the image tag, so it is restricted to [a-z0-9-]. */
  name: string
  state: EnvironmentState
  /** Packages asked for, one per line, comments and pip flags dropped. */
  packages: string[]
  /** Size of the built image in bytes; null when there is nothing built. */
  imageBytes: number | null
  /** When the image was built; null when there is nothing built. */
  builtAt: number | null
  /**
   * True for the one a seminar created from here on will run.
   *
   * Не «на чём работает весь инстанс»: уже созданный семинар держит своё
   * окружение и переживает переключение — иначе смена активного окружения
   * пересоздавала бы ядро под идущей парой (см. AdminSeminar.environment).
   */
  active: boolean
  /** Last build's error, kept so a failure is readable after the log scrolls. */
  error: string | null
  /**
   * Поверх какого окружения этот образ собран — строкой `# colloq: from <имя>`
   * в шапке файла; null — поверх обычной базы, как у большинства.
   *
   * Показывается, потому что объясняет две вещи сразу: почему в списке нет
   * torch, хотя он в комнате есть, и почему «Needs rebuild» может появиться на
   * файле, которого никто не трогал, — родителя пересобрали позже.
   */
  parent: string | null
  /**
   * Окружение просит видеокарту — строкой `# colloq: gpu` в шапке своего файла
   * или в шапке того, поверх чего оно собрано: признак наследуется вместе с
   * колёсами под CUDA.
   *
   * Свойство окружения, а не комнаты: колёса torch в нём собраны под CUDA, и на
   * процессоре такая комната не поедет вовсе. Поэтому срез выдаётся ей на всё
   * время жизни контейнера, а комната на обычном окружении не занимает его
   * никогда.
   */
  gpu: boolean
  /**
   * Какой Python просит окружение — `'3.12'`: своей директивой `# colloq:
   * python`, а у цепочки — директивой её КОРНЯ, потому что версия приходит из
   * базового образа и слоем сверху не меняется.
   *
   * Пустая строка — «неизвестно»: так отвечает опубликованный каталог, который
   * версию не назвал. Показать вместо этого умолчание значило бы выдумать её.
   */
  python: string
  /**
   * Какой Python на самом деле в собранном образе — `'3.12.7'`, из переменной
   * PYTHON_VERSION самого образа; null, если образа нет или он молчит.
   *
   * Отдельно от `python`, потому что расходятся они ровно в том случае, ради
   * которого это и показывают: файл поправили после сборки. Директива — для
   * pip комментарий, `listChanged` её не видит, и без этой пары «Python 3.12» в
   * панели стояло бы над образом с 3.11.
   */
  pythonBuilt: string | null
}

/**
 * Что эта установка может сделать с окружениями — двумя вопросами, а не одним.
 *
 * Одна причина на всё гасила обе кнопки разом: под `make up` сервер сидит в
 * контейнере, репозитория рядом с ним нет, и панель отказывала и в сборке, и в
 * смене умолчания — то есть собрать окружение на арендованной машине можно было
 * только по ssh. Но сборке нужен клиент docker и каталог kernel (контекст
 * читает клиент), а умолчанию — .env, который остаётся на хосте. Разные
 * условия, разные кнопки, разные объяснения.
 */
export interface EnvironmentAbilities {
  /** Собрать образ окружения отсюда. */
  canBuild: boolean
  /** Why not, when `canBuild` is false — shown instead of dead buttons. */
  cannotBuildReason: string | null
  /** Записать `KERNEL_ENV` — то есть решить, на чём поедут новые семинары. */
  canSetDefault: boolean
  /** Почему нет: обычно «это делается на хосте», а не «всё сломано». */
  cannotSetDefaultReason: string | null
}

export interface EnvironmentsState extends EnvironmentAbilities {
  managed?: boolean
  /** False when capacity has not been queried from the Kubernetes scheduler. */
  gpuCapacityKnown?: boolean
  environments: AdminEnvironment[]
  /** Legacy wire field, always false: shared production execution is disabled. */
  shared: boolean
  /**
   * Срезы видеокарты: сколько перечислено в KERNEL_GPUS и сколько сейчас
   * свободно.
   *
   * Свободен тот срез, которого нет ни на одном контейнере комнаты, — считает
   * сервер, потому что знает об этом только он. `total: 0` — обычная установка
   * без карт, а не поломка: панель говорит это словами и не пугает.
   */
  gpus: { total: number; free: number }
}

export interface SaveEnvironmentRequest {
  name: string
  /** The file's whole text, comments and all: this is an editor, not a form. */
  source: string
}

/** Same alphabet as a filename and a Docker tag, and short enough to read. */
export const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/

/**
 * Поверх какого окружения строится это — директива `# colloq: from <имя>` в
 * шапке, в том же виде, что и `# colloq: gpu`.
 *
 * Слой окружения один, и любая правка списка ставит его целиком заново. Для
 * окружения с torch это три гигабайта колёс и девять минут за добавленный timm.
 * Директива переносит тяжёлое в общий слой: родитель собирается один раз, а
 * дети — за секунды.
 *
 * Имя проверяется тем же выражением, что и всюду: оно становится и путём к
 * файлу, и тегом образа. Не имя — не директива; а несуществующее окружение
 * назвать родителем можно, и тогда откажет сборка, назвав его вслух.
 *
 * Здесь, а не только на сервере: форма создания окружения решает по этой же
 * строке, наследуется ли версия Python, и второй разбор той же директивы
 * разъехался бы с первым на первой же правке.
 */
export function declaresParent(source: string): string | null {
  for (const line of source.split('\n')) {
    const found = /^#\s*colloq:\s*from\s+(\S+)\s*$/i.exec(line.trim())
    if (found) return found[1] ?? null
  }
  return null
}

/* ------------------------------------------------------- версия Python */

/**
 * Версии, которые предлагает форма. Ровно те, под которые есть официальный
 * `python:<версия>-slim-bookworm`, — из него и собирается корень цепочки.
 *
 * Список короткий нарочно: это не «любая версия, какую напишут», а те, на
 * которых ядро (jupyter, numpy, pandas, matplotlib, scikit-learn) правда
 * ставится колёсами, без сборки из исходников посреди пары.
 */
export const PYTHON_VERSIONS = ['3.10', '3.11', '3.12', '3.13'] as const

/**
 * На чём собирается окружение, ничего про Python не сказавшее.
 *
 * Обязано совпадать с `ARG PARENT=python:…-slim-bookworm` в kernel/Dockerfile:
 * там это значение и действует, когда мы не передаём PARENT. Расхождение
 * сторожит тест (environment-python.test.mts), а не договорённость.
 */
export const DEFAULT_PYTHON = '3.11'

/**
 * Строка `# colloq: python 3.12` в шапке — та же семья, что `# colloq: gpu` и
 * `# colloq: from <имя>`: для pip это комментарий, для нас — свойство
 * окружения.
 *
 * Свободный текст версией не считается: она уходит в имя базового образа
 * (`python:3.12-slim-bookworm`), и «3.12 или новее» там не существует. 3.9…3.13
 * — то, что вообще принимается; форма предлагает PYTHON_VERSIONS.
 */
const PYTHON_DIRECTIVE = /^#\s*colloq:\s*python\s+(\S+)\s*$/i
const PYTHON_LINE = /^#\s*colloq:\s*python\b/i
const PYTHON_VERSION = /^3\.(?:9|1[0-3])$/

/**
 * Какую версию Python просит этот файл — или null, если не просит никакой.
 *
 * Ищется среди всех комментариев, а не только до первой строки с пакетом:
 * директива, дописанная в конец файла, должна сработать. Строка сравнивается
 * целиком — «# colloq: python не трогайте» директивой не является, как и
 * «# colloq: python 2.7»: такого slim-образа нет, и молча собрать вместо него
 * что-то другое хуже, чем не увидеть директиву вовсе.
 */
export function declaresPython(source: string): string | null {
  for (const line of source.split('\n')) {
    const found = PYTHON_DIRECTIVE.exec(line.trim())
    const version = found?.[1]
    if (version !== undefined && PYTHON_VERSION.test(version)) return version
  }
  return null
}

/**
 * Строка, которая ПОХОЖА на директиву версии, но версией не является.
 *
 * Нужна ровно затем, чтобы редактор сказал об этом вслух: `# colloq: python
 * 3.8` молча читается как «ничего не сказано», и окружение собирается на
 * умолчании — узнать об этом по журналу сборки можно, а по экрану нельзя.
 */
export function unreadablePython(source: string): string | null {
  for (const line of source.split('\n')) {
    const text = line.trim()
    if (!PYTHON_LINE.test(text) || declaresPython(text) !== null) continue
    return text
  }
  return null
}

/**
 * Тот же файл, но просящий именно эту версию.
 *
 * Умолчание директивой не записывается: файл без строки и файл со строкой про
 * 3.11 значат одно и то же, а второй ещё и врёт, если однажды поднимут
 * умолчание в Dockerfile. Старая директива убирается в любом случае — две
 * строки про версию в одной шапке читались бы по первой, а правил бы человек
 * вторую.
 */
export function withPython(source: string, version: string): string {
  const kept = source.split('\n').filter((line) => !PYTHON_LINE.test(line.trim()))
  if (version === DEFAULT_PYTHON) return kept.join('\n')
  return [`# colloq: python ${version}`, ...kept].join('\n')
}

/** Базовый образ корня цепочки. Имя собирается в одном месте — здесь. */
export function pythonImage(version: string): string {
  return `python:${version}-slim-bookworm`
}

/* ------------------------------------------------------ импорт с GitHub */

/**
 * Что получится из ссылки на GitHub, посчитанное без создания комнаты.
 *
 * Показывается до импорта нарочно: преподаватель, вставивший ссылку на папку,
 * хочет увидеть «сто десять ячеек и train.csv» ДО того, как появится семинар,
 * а не после.
 */
export interface ImportPreview {
  /** Имя, выведенное из имени файла или папки; его можно переписать. */
  name: string
  notebook: string
  notebooks: { name: string; cells: number }[]
  cells: number
  files: { name: string; size: number }[]
  /**
   * Файлы, которым не хватило потолка комнаты, — по именам.
   *
   * Сумма размеров ограничена так же, как у загрузки через панель
   * (`server/src/routes/admin-import.ts` · withinRoomBudget), и остаток
   * отсекается ещё до того, как комнату заведут. Сказать об этом надо здесь:
   * узнать, что половина датасета не приехала, после импорта — поздно.
   */
  skipped: string[]
  /** owner/repo/path — чтобы было видно, откуда это взялось. */
  source: string
}

export interface ImportResult {
  id: string
  name: string
  url: string
  cells: number
  files: string[]
  /** Файлы, которые не удалось забрать: имя не годится или скачивание упало. */
  skipped: string[]
  createdBy: string | null
}
