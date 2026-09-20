import {tr} from '@shared/i18n'
import type {
  AiAskRequest,
  AiAskResponse,
  Ban,
  CouncilOracle,
  CreateSessionResponse,
  FileEntry,
  HandoffResponse,
  JoinRequest,
  JoinResponse,
  Participant,
  SessionInfo,
  SessionMe,
} from '@shared/protocol'
import type { ReasoningEffort } from '@shared/admin'
import type { RoomRules } from '@shared/rules'
import type { PublicCourseView, PublicSeminar, PublicStep } from '@shared/publish'
import type { PersonMark } from './bans'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * Сколько секунд ждать, если сервер назвал срок.
     *
     * Только там, где отказ — это ожидание, а не поломка: слоу-мод оракула
     * присылает его в теле, и по нему экран решает показать спокойную строку с
     * обратным отсчётом вместо красной ошибки. Отличить ожидание от аварии по
     * тексту 429 нельзя, а гадать по нему — заводить второй свод правил рядом
     * с серверным.
     */
    readonly retryAfter: number | null = null,
    /**
     * До какого момента человека не пустят, если отказ — это бан.
     *
     * Рядом с `retryAfter` и по тому же поводу: 403 бывает и «правило комнаты»,
     * и «вас удалили с занятия», а различить их по тексту — завести второй свод
     * правил рядом с серверным. Момент, а не остаток: часы рисует тот, кто
     * смотрит (см. `untilWords` в lib/bans.ts).
     */
    readonly until: number | null = null,
  ) {
    super(message)
  }
}

/**
 * Что сказать, когда сервер не сказал ничего.
 *
 * HTTP/2 отменил строку состояния — `res.statusText` там пустая всегда, а не
 * иногда. Ошибка, у которой нет тела с полем error, доезжала до экрана пустой
 * строкой, а `{#if error}` пустую строку не показывает: отказ выглядел как
 * будто ничего не произошло. Код есть всегда, и назвать его — уже лучше, чем
 * промолчать.
 */
export function statusMessage(res: Response): string {
  if (res.status === 401) return tr('common.http401')
  if (res.status === 403) return tr('common.http403')
  if (res.status === 404) return tr('common.http404')
  if (res.status === 413) return tr('common.http413')
  if (res.status === 429) return tr('common.http429')
  if (res.status >= 500) return tr('common.serverFailed',{status:res.status})
  return tr('common.requestFailed',{status:res.status})
}

/**
 * Один запрос к нашему API: те же заголовки, тот же разбор отказа, те же слова.
 *
 * Экспортируется ради ленты версий (lib/history.ts): у неё был свой почти
 * такой же `get`, отличавшийся ровно заголовком Authorization — который сюда и
 * так передаётся через `init.headers`. Две копии разбора ошибок расходятся на
 * первой же правке: `retryAfter` и `until` в теле отказа появились здесь и в
 * копию не доехали.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        ...(init?.body && !(init.body instanceof FormData)
          ? { 'content-type': 'application/json' }
          : {}),
        ...init?.headers,
      },
    })
  } catch (cause: unknown) {
    /*
     * fetch отвергает обещание TypeError'ом со словами «Failed to fetch» —
     * фразой из отладчика, а не для человека, и одинаковой для упавшего
     * сервера, оборванного вайфая и закрытого туннеля. Ни одного из этих
     * случаев она не называет; сказать, что связь пропала, честнее.
     */
    if (cause instanceof TypeError) {
      throw new ApiError(tr('common.networkError'), 0)
    }
    throw cause
  }
  if (!res.ok) {
    let message = statusMessage(res)
    let retryAfter: number | null = null
    let until: number | null = null
    try {
      const body = (await res.json()) as { error?: string; retryAfter?: number; until?: number }
      if (body?.error) message = body.error
      if (typeof body?.retryAfter === 'number' && Number.isFinite(body.retryAfter)) {
        retryAfter = body.retryAfter
      }
      if (typeof body?.until === 'number' && Number.isFinite(body.until)) until = body.until
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status, retryAfter, until)
  }
  return (await res.json()) as T
}

export const api = {
  createSession: (name: string) =>
    request<CreateSessionResponse>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  getSession: (id: string) => request<SessionInfo>(`/api/sessions/${id}`),

  /**
   * «А меня-то пускают» — вопрос от вкладки, которой отказали в рукопожатии.
   *
   * Единственный запрос в продукте, который спрашивают ключом и ждут ответа про
   * сам ключ. Сокет отказывает ДО апгрейда и без слов, и без этой двери клиент
   * различал два случая из трёх наугад: забаненный после перезагрузки читал
   * «место истекло» и терял свою личность в комнате. Что именно отвечает
   * сервер — у `SessionMe` в shared/protocol.ts.
   */
  me: (id: string, token: string) =>
    request<SessionMe>(`/api/sessions/${id}/me`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  join: (id: string, body: JoinRequest) =>
    request<JoinResponse>(`/api/sessions/${id}/join`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * Ключ, которым преподаватель отдаёт свой пульт планшету.
   *
   * Ключ, а не токен: см. `signHandoffToken` на сервере. Живёт десять минут и
   * годится ровно на один обмен ниже.
   */
  handoff: (id: string, token: string) =>
    request<HandoffResponse>(`/api/sessions/${id}/handoff`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    }),

  /** Планшет меняет ключ из ссылки на обычный вход — тем же человеком. */
  claimHandoff: (id: string, key: string) =>
    request<JoinResponse>(`/api/sessions/${id}/handoff/claim`, {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),

  /** Everyone who has ever joined, newest activity first. */
  listParticipants: (id: string) =>
    request<{ participants: Participant[]; online: string[] }>(`/api/sessions/${id}/participants`),

  /* --------------------------------------------------------------- баны */

  /**
   * Удалить человека с занятия на сутки.
   *
   * Сутки называет сервер, а не эта строка: срок один на продукт, и второе
   * место, где он написан, разошлось бы с первым на первой же правке. Отсюда
   * уезжает только «кого».
   */
  ban: (id: string, token: string, participantId: string) =>
    request<{ ban: Ban }>(`/api/sessions/${id}/bans`, {
      method: 'POST',
      body: JSON.stringify({ participantId }),
      headers: { authorization: `Bearer ${token}` },
    }),

  /**
   * Действующие баны — и пометки про тех, кто в комнате сейчас.
   *
   * Одним запросом, потому что это один и тот же разговор и одно и то же
   * право: метка устройства, адрес и «первый раз здесь» — то, чего вкладка про
   * соседа не знает и знать не должна, а преподавателю без них не отличить
   * вернувшегося от однофамильца. `marks` не обязателен: сервер, который про
   * пометки ещё не знает, оставляет список людей таким, каким он был.
   */
  bans: (id: string, token: string) =>
    request<{ bans: Ban[]; marks?: Record<string, PersonMark> }>(`/api/sessions/${id}/bans`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  /** Снять бан. Вопросы к оракулу этим не возвращаются — их возвращает история. */
  liftBan: (id: string, token: string, banId: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/bans/${banId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),

  /**
   * Правила комнаты — из самой комнаты.
   *
   * Накладывается на текущее на сервере: экран, трогающий одну строку, не
   * должен уметь молча вернуть остальные к умолчаниям.
   */
  setRoomRules: (id: string, token: string, rules: Partial<RoomRules>) =>
    request<{ rules: RoomRules }>(`/api/sessions/${id}/rules`, {
      method: 'PATCH',
      body: JSON.stringify({ rules }),
      headers: { authorization: `Bearer ${token}` },
    }),

  /* --------------------------------------------------- публичное чтение */

  /**
   * Курс и опубликованный семинар — без токена и без входа.
   *
   * Отдельные адреса, а не `/api/sessions/...`: у публикации свой
   * идентификатор именно затем, чтобы ссылка «на почитать» не открывала живую
   * комнату.
   */
  course: (id: string) => request<{ course: PublicCourseView }>(`/api/c/${id}`),

  publication: (id: string) => request<{ seminar: PublicSeminar }>(`/api/p/${id}`),

  step: (id: string, seq: number | null) =>
    request<{ step: PublicStep }>(`/api/p/${id}/step/${seq === null ? 'first' : seq}`),

  // `truncated` — дерево показано не целиком: обход упёрся в потолок. Тот же
  // признак едет в сообщении `files` по сокету, и комната хранит один флаг.
  listFiles: (id: string, token: string) =>
    request<{ files: FileEntry[]; truncated?: boolean }>(`/api/sessions/${id}/files`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  uploadFiles: async (id: string, files: File[], token: string) => {
    const form = new FormData()
    for (const file of files) form.append('file', file, file.name)
    return request<{ files: FileEntry[] }>(`/api/sessions/${id}/files`, {
      method: 'POST',
      body: form,
      headers: { authorization: `Bearer ${token}` },
    })
  },

  deleteFile: (id: string, path: string, token: string) =>
    request<{ files: FileEntry[] }>(`/api/sessions/${id}/file?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),

  /*
   * The token rides in the query string because this URL ends up in an
   * <a href download>, and an anchor cannot send a header. It is the same
   * seminar-scoped credential the rest of the panel already uses.
   */
  /**
   * A download link, good for this one file for five minutes.
   *
   * Two steps rather than one because an `<a href download>` cannot carry a
   * header: the session token goes up in a header to fetch a ticket, and only
   * the ticket rides in the URL. The link used to carry the session token
   * itself, which meant "copy link address" into a group chat handed every
   * reader the control socket under the teacher's name.
   */
  fileTicket: (id: string, path: string, token: string) =>
    request<{ token: string }>(`/api/sessions/${id}/file/ticket?path=${encodeURIComponent(path)}`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  /*
   * Путь — в строке запроса, а не в адресе, и так везде в продукте: косая черта
   * внутри имени живёт в адресе только как `%2F`, а его по дороге разворачивает
   * то один прокси, то другой.
   */
  fileUrl: (id: string, path: string, ticket: string) =>
    `/api/sessions/${id}/file?path=${encodeURIComponent(path)}&token=${encodeURIComponent(ticket)}`,

  /**
   * Ключ на картинки вывода этой комнаты — один на все.
   *
   * То же, что у файла, и по той же причине: адрес уезжает в `src` элемента
   * `<img>`, а туда не положить заголовок. Отличие одно — ключ не на запись, а
   * на комнату: вывод одной ячейки это десяток картинок, и спрашивать ключ на
   * каждую значило бы десяток запросов на каждый график. Открывает он ровно
   * то, что человек и так видит в тетради.
   */
  blobTicket: (id: string, token: string) =>
    request<{ token: string }>(`/api/sessions/${id}/blobs/ticket`, {
      headers: { authorization: `Bearer ${token}` },
    }),

  /** Адрес картинки вывода. Имя — хэш содержимого, поэтому кэш вечный. */
  blobUrl: (id: string, sha: string, ticket: string) =>
    `/api/sessions/${id}/blobs/${encodeURIComponent(sha)}?token=${encodeURIComponent(ticket)}`,

  /**
   * Тот же файл, но без билета в строке запроса — для читалки.
   *
   * Билет нужен якорю: `<a download>` не умеет отправить заголовок. Читалка
   * ходит сама и отправляет токен заголовком, поэтому адрес чистый — а pdf.js
   * по нему запрашивает документ кусками и показывает первую страницу, не
   * дожидаясь последней.
   */
  fileRaw: (id: string, path: string) =>
    `/api/sessions/${id}/file?path=${encodeURIComponent(path)}`,

  /**
   * `mode` is what the server actually enforces; `enabled` is `mode !== 'off'`.
   *
   * Два потолка — инстансовые, до правил комнаты: пульт правил показывает их
   * рядом со своими полями, иначе «как на инстансе» не называет числа.
   */
  aiStatus: () =>
    request<{
      enabled: boolean
      model: string
      mode: 'full' | 'hints' | 'off'
      questionsPerHour: number
      slowModeSeconds: number
      agentSteps?: number
      /** Умолчание уровня размышлений; необязательное — сервер мог быть старее панели. */
      reasoningEffort?: ReasoningEffort
    }>('/api/ai/status'),

  /**
   * Fire-and-forget. The server appends the question to the shared document and
   * streams the answer into it. The response entryId links the optimistic row
   * to that entry; the browser reads the answer from the CRDT like everyone else.
   */
  aiAsk: (id: string, token: string, body: AiAskRequest) =>
    request<AiAskResponse>(`/api/sessions/${id}/ai/ask`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}` },
    }),

  /**
   * Свою запись останавливает автор, чужую — преподаватель.
   *
   * Не «кто угодно»: оборвать чужой ход агента значит бросить правку файлов на
   * середине. Сервер отказывает словами (routes/ai.ts), кнопка гаснет заранее
   * (ChatTurn.svelte) — правило одно, мест два.
   */
  aiCancel: (id: string, token: string, entryId: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/ai/cancel`, {
      method: 'POST',
      body: JSON.stringify({ entryId }),
      headers: { authorization: `Bearer ${token}` },
    }),

  /** Host only — the transcript belongs to the room. Rejected with 403 otherwise. */
  aiClearThread: (id: string, token: string) =>
    request<{ ok: true }>(`/api/sessions/${id}/ai/thread`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),

  /* ----------------------------------------------------------- консилиум */

  /**
   * Спросить оракула о решениях в ячейке консилиума — один вопрос из лимита
   * комнаты, только преподаватель.
   *
   * Ответ здесь — состояние «читает»; готовая сводка приедет по управляющему
   * сокету (`council:oracle`), как и всё остальное про стопку. По HTTP, а не
   * сообщением сокета, потому что у отказа есть цена и срок: 429 со словами и
   * `retryAfter`, которые сокет не умеет сказать так же (см. `ApiError`).
   */
  councilAsk: (
    id: string,
    token: string,
    cellId: string,
    question?: string,
    effort?: ReasoningEffort,
  ) =>
    request<CouncilOracle>(`/api/sessions/${id}/council/${encodeURIComponent(cellId)}/oracle`, {
      method: 'POST',
      /*
       * Вопрос о классе своими словами; без него сервер подставляет свою
       * заготовку (routes/council.ts). Пустой строки здесь не бывает: пульт не
       * шлёт вопроса, которого нет.
       *
       * `effort` не шлётся вовсе, когда выбрано «как на инстансе»: провайдеру
       * тогда не уедет ни одного нового поля.
       */
      body: JSON.stringify({ ...(question ? { question } : {}), ...(effort ? { effort } : {}) }),
      headers: { authorization: `Bearer ${token}` },
    }),

  /** Стоп: оборвать чтение оракула о решениях. Вопрос из лимита не возвращается. */
  councilStopOracle: (id: string, token: string, cellId: string) =>
    request<CouncilOracle>(`/api/sessions/${id}/council/${encodeURIComponent(cellId)}/oracle`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    }),
}
