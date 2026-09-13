import {tr} from '@shared/i18n'
/**
 * The /api/admin client.
 *
 * Every call sends `credentials: 'include'`. The staff cookie is HttpOnly, so
 * the browser is the only thing that can attach it — and fetch leaves it off by
 * default even same-origin, which would make every admin request a silent 401.
 */
import type { RoomRules } from '@shared/rules'
import type {
  AdminErrorBody,
  AdminMe,
  AdminRole,
  AdminSeminar,
  OracleSettings,
  OracleTestResult,
  OracleUsage,
  ClaimRequest,
  CreateSeminarRequest,
  EnvironmentsState,
  ImportPreview,
  ImportResult,
  InstanceResources,
  InstanceState,
  InstanceSettings,
  SaveEnvironmentRequest,
  SignInWithTokenRequest,
  Teacher,
  TeacherWithLink,
  UpdateOracleRequest,
  UpdateSeminarRequest,
} from '@shared/admin'
import type {
  AddressHolder,
  Course,
  CourseItem,
  PublishCandidate,
  SkippedStep,
} from '@shared/publish'

export type AdminErrorReason = AdminErrorBody['reason']

/**
 * `reason` is the branch callers actually want: 'unauthenticated' means send
 * them to /admin, everything else is a message to show where they stand.
 */
export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason: AdminErrorReason,
    /**
     * Тело отказа целиком — не всё в отказе умещается в одну фразу.
     *
     * 409 на смену адреса называет держателя имени (`holder`), и без него
     * панель может только повторить «уже занят»: назвать курс, который его
     * держит, и тем более отпустить прежнее имя, ей уже нечем.
     */
    readonly body: unknown = null,
  ) {
    super(message)
  }
}

/**
 * Держатель адреса из отказа 409 — или null, если отказ не о том.
 *
 * Разбор здесь, а не в компоненте: это значение приехало по сети, и верить ему
 * на слово нельзя. Пока сервер держателя не называет (или назвал невнятно),
 * панель ведёт себя ровно как раньше — показывает фразу отказа и не предлагает
 * ничего отпускать.
 */
export function addressHolderOf(error: unknown): AddressHolder | null {
  if (!(error instanceof AdminApiError) || error.status !== 409) return null
  const holder = (error.body as { holder?: unknown } | null)?.holder
  if (!holder || typeof holder !== 'object') return null
  const it = holder as Partial<AddressHolder>
  if (it.kind !== 'course' && it.kind !== 'publication') return null
  if (typeof it.id !== 'string' || !it.id) return null
  return {
    kind: it.kind,
    id: it.id,
    name: typeof it.name === 'string' ? it.name : '',
    former: it.former === true,
  }
}

/**
 * The two request DTOs the staff list needs that the shared contract does not
 * name. Nobody is created as an owner: promotion is a second, deliberate act,
 * which is also why the patch carries nothing but the role.
 */
export interface CreateTeacherRequest {
  name: string
  email: string
}

/** Роль, личные данные или и то и другое — сервер принимает любую комбинацию. */
export interface UpdateTeacherRequest {
  role?: AdminRole
  name?: string
  email?: string
}

/**
 * Публичная страница сама по себе, а не как поле семинара.
 *
 * `orphaned` — страница, у которой комнату удалили: все остальные маршруты
 * публикации ключуются идентификатором комнаты, так что снять её было нечем,
 * хотя сервер её отдаёт, а `make site` выкладывает.
 */
export interface AdminPublication {
  id: string
  slug: string | null
  sessionId: string | null
  title: string
  state: 'published' | 'withdrawn'
  publishedAt: number
  publishedBy: string | null
  revision: number
  orphanedAt: number | null
  steps: number
  orphaned: boolean
}

const BASE = '/api/admin'

/** A body that is not an AdminErrorBody still has a status worth trusting. */
function reasonForStatus(status: number): AdminErrorReason {
  if (status === 401) return 'unauthenticated'
  if (status === 403) return 'forbidden'
  return 'invalid'
}

/**
 * `base` — не украшение: описание МАШИНЫ живёт не под /api/admin.
 *
 * Ресурсы инстанса — про железо, а не про панель, и дверь у них своя
 * (/api/instance/resources). Разбор отказа, печенье и сеть при этом обязаны
 * быть теми же: вторая копия этого кода разошлась бы с первой на первом же
 * изменении в обработке 401.
 */
async function request<T>(path: string, init?: RequestInit, base = BASE): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch (cause: unknown) {
    // «Failed to fetch» — фраза из отладчика, одинаковая для упавшего сервера,
    // оборванного вайфая и закрытого туннеля. Ни одного из них она не называет.
    if (cause instanceof TypeError) {
      throw new AdminApiError(
        tr('common.networkError'),
        0,
        'network',
      )
    }
    throw cause
  }

  if (!res.ok) {
    // HTTP/2 отменил строку состояния: res.statusText там пустая всегда, и
    // отказ доезжал до экрана пустой строкой, которую `{#if error}` не рисует.
    let message = tr('common.requestFailed',{status:res.status})
    let reason = reasonForStatus(res.status)
    let said: unknown = null
    try {
      const body = (await res.json()) as Partial<AdminErrorBody>
      said = body ?? null
      if (body?.error) message = body.error
      if (body?.reason) reason = body.reason
    } catch {
      /* non-JSON error body */
    }
    throw new AdminApiError(message, res.status, reason, said)
  }

  // Deletes and sign-out answer with no body; asking json() for one throws.
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  return (await res.json()) as T
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

export const adminApi = {
  getInstanceSettings: () => request<InstanceSettings>('/instance/settings'),
  updateInstanceSettings: (body: InstanceSettings) => request<InstanceSettings>('/instance/settings', {method:'PATCH',...json(body)}),
  /* ------------------------------------------------------------- session */

  /** Open to anyone: it is what tells the panel whether to show the claim form. */
  state: () => request<InstanceState>('/state'),

  me: () => request<AdminMe>('/me'),

  claim: (body: ClaimRequest) => request<AdminMe>('/claim', { method: 'POST', ...json(body) }),

  signInWithToken: (token: string) =>
    request<AdminMe>('/signin/token', {
      method: 'POST',
      ...json({ token } satisfies SignInWithTokenRequest),
    }),

  /**
   * The key travels in the body rather than the path: a URL ends up in access
   * logs and proxy traces, and this one is a credential until it is spent.
   */
  signInWithKey: (key: string) =>
    request<AdminMe>('/signin/key', { method: 'POST', ...json({ key }) }),

  signOut: () => request<void>('/signout', { method: 'POST' }),

  /* ------------------------------------------------------- импорт с GitHub */

  /** Что получится из ссылки — до того, как что-то создано. */
  previewImport: (url: string) =>
    request<ImportPreview>('/import/preview', { method: 'POST', ...json({ url }) }),

  importSeminar: (body: {
    url: string
    name?: string
    environment?: string | null
    /*
     * Режим — тот же пресет правил, что и у пустой комнаты (см.
     * CreateSeminarRequest.mode). Он есть у всех трёх дверей, потому что
     * лекцию заводят как раз из готовой тетради чаще, чем с чистого листа.
     */
    mode?: 'lab' | 'lecture' | 'council'
    rules?: Partial<RoomRules>
  }) => request<ImportResult>('/import', { method: 'POST', ...json(body) }),

  /* -------------------------------------------------------- environments */

  listEnvironments: () => request<EnvironmentsState>('/environments'),

  /** The file itself. The list carries parsed packages; the editor needs text. */
  readEnvironment: (name: string) =>
    request<{ name: string; source: string }>(`/environments/${encodeURIComponent(name)}`),

  /**
   * Записать список пакетов; в режиме создания — только если имени ещё нет.
   *
   * PUT один и тот же для «завёл окружение» и «поправил список», а намерения
   * разные: форма создания на занятом имени затирала чужой список целиком, и
   * проверка по списку на экране закрывает это только до тех пор, пока рядом
   * нет второй вкладки. `If-None-Match: *` — это «только если такого ещё нет»:
   * сервер отвечает 409 с reason 'exists' и файла не трогает.
   */
  saveEnvironment: (name: string, source: string, opts?: { creating?: boolean }) =>
    request<{ name: string; source: string }>(`/environments/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: opts?.creating ? { 'if-none-match': '*' } : {},
      ...json({ name, source } satisfies SaveEnvironmentRequest),
    }),

  deleteEnvironment: (name: string) =>
    request<void>(`/environments/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  buildEnvironment: (name: string) =>
    request<{ name: string }>(`/environments/${encodeURIComponent(name)}/build`, {
      method: 'POST',
    }),

  cancelEnvironmentBuild: (name: string) =>
    request<{ cancelled: boolean }>(`/environments/${encodeURIComponent(name)}/cancel`, {
      method: 'POST',
    }),

  useEnvironment: (name: string) =>
    request<{ active: string }>(`/environments/${encodeURIComponent(name)}/use`, {
      method: 'POST',
    }),

  /* ------------------------------------------------------------ seminars */

  /* ----------------------------------------------------------- ресурсы */

  /**
   * Чем располагает машина: память, ядра, карты и умолчания ядра по окружениям.
   *
   * Читается формой занятия, чтобы поле «сколько памяти» не было гаданием.
   * Своя дверь мимо /api/admin: это описание машины, а не панели.
   */
  resources: () => request<InstanceResources>('/resources', undefined, '/api/instance'),

  listSeminars: () => request<AdminSeminar[]>('/seminars'),

  createSeminar: (body: CreateSeminarRequest) =>
    request<AdminSeminar>('/seminars', { method: 'POST', ...json(body) }),

  updateSeminar: (id: string, body: UpdateSeminarRequest) =>
    request<AdminSeminar>(`/seminars/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...json(body),
    }),

  /* ------------------------------------------------------------ курсы */

  listCourses: () => request<{ courses: Course[] }>('/courses').then((r) => r.courses),

  course: (id: string) =>
    request<{ course: Course }>(`/courses/${encodeURIComponent(id)}`).then((r) => r.course),

  createCourse: (body: { name: string; blurb?: string }) =>
    request<{ course: Course }>('/courses', { method: 'POST', ...json(body) }).then(
      (r) => r.course,
    ),

  updateCourse: (id: string, body: { name?: string; blurb?: string | null }) =>
    request<{ course: Course }>(`/courses/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      ...json(body),
    }).then((r) => r.course),

  /**
   * Состав и порядок — целиком, со сравнением версии.
   *
   * 409 несёт курс таким, какой он сейчас: это не ошибка, а гонка, и экран
   * должен показать правду, а не спорить с ней.
   */
  setCourseItems: (id: string, rev: number, items: CourseItem[]) =>
    request<{ course: Course }>(`/courses/${encodeURIComponent(id)}/items`, {
      method: 'PUT',
      ...json({ rev, items }),
    }).then((r) => r.course),

  /**
   * Имя в адресе — курсу или публикации.
   *
   * Отдельным вызовом, а не полем в PATCH: занятое имя — отказ, о котором надо
   * сказать словами, а не пропажа среди других полей, сохранившихся успешно.
   */
  setSlug: (kind: 'course' | 'publication', id: string, slug: string | null) =>
    request<{ slug: string | null }>(`/slug/${kind}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      ...json({ slug }),
    }),

  /**
   * Отпустить своё прежнее имя в адресе.
   *
   * Прежнее имя держится вечно и не зря: ссылку с ним записали в чате группы.
   * Но курс «ml-2025», переименованный в «ml-2025-fall», держал «ml-2025» и для
   * курса следующего года — навсегда, и освободить его было нечем, кроме
   * удаления курса-владельца. `id` здесь — держателя, а не того, кому имя
   * понадобилось: отпускает только владелец имени и только прежнее.
   *
   * Цена необратима и названа вслух на экране: старая ссылка станет 404.
   */
  releaseFormerSlug: (kind: AddressHolder['kind'], id: string, slug: string) =>
    request<void>(
      `/slug/${kind}/${encodeURIComponent(id)}/former/${encodeURIComponent(slug)}`,
      { method: 'DELETE' },
    ),

  deleteCourse: (id: string) =>
    request<void>(`/courses/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* ------------------------------------------------------- публикация */

  /**
   * `slug` описан здесь намеренно: сервер отдавал его с самого начала, а тип
   * его отбрасывал — и экран публикации, не зная о действующем адресе,
   * предлагал новый из названия и ломал тот, что уже продиктовали классу.
   */
  publishInfo: (id: string) =>
    request<{
      title: string
      candidates: PublishCandidate[]
      publication: {
        id: string
        slug: string | null
        steps: { seq: number; label: string; at: number }[]
        /**
         * Прежние имена этой страницы в адресе (`Course.former` в shared).
         *
         * Сервер везёт их вместе с самой публикацией (routes/courses.ts ·
         * `formerSlugs`), а тип их отбрасывал — и экран публикации держал
         * своё объявление поля, чтобы отпустить прежнее имя было чем.
         * Необязательное: сервер постарее его не присылает вовсе.
         */
        former?: string[]
      } | null
    }>(`/seminars/${encodeURIComponent(id)}/publish`),

  /**
   * `skipped` — моменты, которые шагами не стали, и почему.
   *
   * Молчание здесь стоило страницы: преподаватель отмечал семь моментов,
   * получал шесть шагов и не знал, какой пропал. Сервер называет их поимённо
   * (shared/publish.ts · SkippedStep), и экран обязан их показать — иначе поле
   * снова уедет в никуда.
   */
  publish: (id: string, steps: { seq: number; label: string; at: number }[], finalLabel?: string) =>
    request<{
      publication: { id: string; slug: string | null; steps: { seq: number; label: string }[] }
      skipped: SkippedStep[]
    }>(`/seminars/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      ...json({ steps, finalLabel }),
    }),

  withdraw: (id: string) =>
    request<void>(`/seminars/${encodeURIComponent(id)}/publish`, { method: 'DELETE' }),

  republish: (id: string) =>
    request<void>(`/seminars/${encodeURIComponent(id)}/publish/restore`, { method: 'POST' }),

  /**
   * Комната — и, если так решили, её публичная страница.
   *
   * Умолчание сервера — страницу оставить: розданную классу ссылку не отозвать.
   * Но выбор он объявляет («судьба страницы спрашивается отдельно»), а задать
   * вопрос может только панель — иначе осиротевшую страницу уже ничем не снять.
   */
  deleteSeminar: (id: string, dropReading = false) =>
    request<void>(`/seminars/${encodeURIComponent(id)}${dropReading ? '?reading=drop' : ''}`, {
      method: 'DELETE',
    }),

  /* ------------------------------------------- страницы без комнаты */

  /**
   * Публикации, ключом которым служит их собственный адрес.
   *
   * Всё остальное здесь спрашивает публикацию по семинару, а у осиротевшей
   * семинара уже нет: `withdraw`/`republish` отвечают ей 404, и снять её можно
   * было только правкой SQLite.
   */
  listPublications: () =>
    request<{ publications: AdminPublication[] }>('/publications').then((r) => r.publications),

  withdrawPublication: (id: string) =>
    request<void>(`/publications/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  restorePublication: (id: string) =>
    request<void>(`/publications/${encodeURIComponent(id)}/restore`, { method: 'POST' }),

  /** Совсем: строки страницы стираются, надгробие в курсе теряет ссылку. */
  erasePublication: (id: string) =>
    request<void>(`/publications/${encodeURIComponent(id)}/forever`, { method: 'DELETE' }),

  /* ----------------------------------------------------------- oracle */

  oracle: () => request<OracleSettings>('/oracle'),

  /**
   * A whole-settings write: omitting `apiKey` leaves the stored secret alone,
   * which is the only way a form that never receives the key can save the rest.
   */
  updateOracle: (body: UpdateOracleRequest) =>
    request<OracleSettings>('/oracle', { method: 'PUT', ...json(body) }),

  /** Talks to the configured provider from the server, so it proves the real path. */
  testOracle: () => request<OracleTestResult>('/oracle/test', { method: 'POST' }),

  /** `since` is a timestamp in ms; the server clamps it and picks a term by default. */
  oracleUsage: (since?: number) =>
    request<OracleUsage>(since ? `/oracle/usage?since=${since}` : '/oracle/usage'),

  /* ------------------------------------------------------------ teachers */

  listTeachers: () => request<Teacher[]>('/teachers'),

  /** Answers with the link, which is the only moment it is ever readable. */
  createTeacher: (body: CreateTeacherRequest) =>
    request<TeacherWithLink>('/teachers', { method: 'POST', ...json(body) }),

  /**
   * Третья дверь: тетрадь с диска.
   *
   * Тело JSON, а не multipart: .ipynb — это и есть JSON, и читать его в
   * браузере дешевле, чем поднимать разбор многочастного тела ради одного поля.
   *
   * Едут только ячейки — `cell_type` и `source`, — а не файл целиком. Предел на
   * тело общий, 1 МБ, и сохранённая тетрадь с парой графиков его пробивала:
   * выводы в ней — мегабайты base64, которые сервер всё равно выбрасывает.
   */
  importNotebook: (body: {
    cells: unknown[]
    filename: string
    name?: string
    environment?: string | null
    mode?: 'lab' | 'lecture' | 'council'
    rules?: unknown
  }) => request<ImportResult>('/import/notebook', { method: 'POST', ...json(body) }),

  /**
   * Материал в комнату, от имени преподавателя.
   *
   * Идёт мимо `${BASE}`: это маршрут семинара, а не панели, и принимает он
   * печенье преподавателя наравне с токеном участника. `credentials: 'include'`
   * здесь и есть вся авторизация.
   */
  uploadMaterial: async (sessionId: string, file: File): Promise<void> => {
    const form = new FormData()
    form.append('file', file, file.name)
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    })
    if (!res.ok) {
      let message = res.statusText || `The upload failed (${res.status})`
      try {
        const body = (await res.json()) as { error?: string }
        if (body?.error) message = body.error
      } catch {
        /* non-JSON error body */
      }
      throw new AdminApiError(message, res.status, reasonForStatus(res.status))
    }
  },

  updateTeacher: (id: string, body: UpdateTeacherRequest) =>
    request<Teacher>(`/teachers/${encodeURIComponent(id)}`, { method: 'PATCH', ...json(body) }),

  deleteTeacher: (id: string) =>
    request<void>(`/teachers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Mints a fresh link and kills the old one in the same call. */
  rotateTeacherLink: (id: string) =>
    request<TeacherWithLink>(`/teachers/${encodeURIComponent(id)}/rotate`, { method: 'POST' }),

  /**
   * The existing link, for re-sending it to someone who mislaid theirs. Owner
   * only. It goes to the clipboard, never onto the screen — the row keeps
   * showing the masked shape.
   */
  teacherLink: (id: string) => request<TeacherWithLink>(`/teachers/${encodeURIComponent(id)}/link`),

  /**
   * Отозвать токен установки и получить новый.
   *
   * Токен подписывает вошедшего как самого старого владельца и печатается
   * `make host` при каждом запуске: он есть в истории терминала, на снимках
   * проектора и в чатах, куда его пересылали. Отозвать его было нечем.
   */
  rotateSetupToken: () => request<{ token: string }>('/setup-token/rotate', { method: 'POST' }),
}
