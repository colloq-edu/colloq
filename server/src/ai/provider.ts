/**
 * The model endpoint, kept deliberately thin.
 *
 * Colloq targets "any OpenAI-compatible endpoint" — OpenAI, vLLM, Ollama,
 * LM Studio, OpenRouter — so this module sticks to the smallest request that
 * all of them honour, and translates SDK failures into a sentence a teacher
 * standing in front of a class can act on.
 *
 * Everything here reads resolveAiConfig() rather than config.ai: the key, host
 * and model can now be edited from the admin panel, and a value memoised at
 * import would mean a teacher's fix only landing on the next restart.
 */
import OpenAI from 'openai'
import { config } from '../config.js'
import { tally } from '../log.js'
import { resolveAiConfig } from '../admin/settings.js'
import { isKeylessProvider, providerConfigured, type OracleTestResult } from '@shared/admin'

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Инструменты, которые модель попросила выполнить этим ходом. */
  calls?: ToolCall[]
  /** Ответ инструмента: у него есть адресат — тот вызов, на который он отвечает. */
  callId?: string
}

/** Один вызов инструмента: имя и аргументы, как их прислала модель. */
export interface ToolCall {
  id: string
  name: string
  /** JSON строкой — ровно как пришло. Разбирает вызывающий, он же и отвечает за кривое. */
  args: string
}

/** Описание инструмента в том виде, в каком его понимает OpenAI-совместимый эндпоинт. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A teacher pressed a button and is watching a spinner; the seminar timeout is far too long for that. */
const TEST_TIMEOUT_MS = 20_000

/**
 * Проба идёт ровно один раз, и в этом весь смысл срока.
 *
 * Клиент заведён с `maxRetries: 1`, а SDK повторяет и таймауты соединения: под
 * «чёрной дырой» проба ждала два раза по двадцать секунд и отвечала «did not
 * answer within 20 seconds». Преподаватель смотрел на спиннер сорок секунд и
 * читал про двадцать. Повтор здесь и не нужен: кнопку жмут руками, и повторить
 * её — тоже.
 */
const ONE_TRY = { timeout: TEST_TIMEOUT_MS, maxRetries: 0 }

/** Enough of the endpoint's own words to be useful, not enough to paste a stack trace into the UI. */
const MAX_DETAIL = 200

let client: OpenAI | null = null
let clientFor = ''

/**
 * One client per (key, host) pair. The old code built the client once and kept
 * it forever, which was invisible while the only source of both was the
 * environment — with a settings panel it becomes "I pasted the new key and it
 * still says the key is wrong".
 */
function getClient(): OpenAI {
  const ai = resolveAiConfig()
  const fingerprint = JSON.stringify([ai.apiKey, ai.baseUrl])
  if (!client || fingerprint !== clientFor) {
    client = new OpenAI({
      // Local runtimes ignore the key but the SDK refuses to construct without one.
      apiKey: ai.apiKey || 'not-needed',
      baseURL: ai.baseUrl,
      // A seminar would rather see the failure than wait through a retry storm.
      maxRetries: 1,
      timeout: 120_000,
    })
    clientFor = fingerprint
  }
  return client
}

export function providerReady(): boolean {
  const ai = resolveAiConfig()
  // A key, or a runtime that has no concept of one: pointing Colloq at the
  // Ollama on the lecturer's own machine is a complete configuration, and
  // reporting it as unconfigured would be the panel's first lie.
  //
  // Правило живёт в shared и только там: панель считает потолок комнаты той же
  // функцией (web/src/admin/panel.ts), и когда у сервера была своя копия, они
  // разошлись — на настроенной Ollama экран гасил режимы, а оракул отвечал.
  return providerConfigured({
    provider: ai.provider,
    baseUrl: ai.baseUrl,
    hasKey: ai.apiKey.length > 0,
  })
}

export function providerModel(): string {
  return resolveAiConfig().model
}

/**
 * What a delta belongs to. Everything an endpoint volunteers before the answer
 * proper — OpenRouter's `reasoning`, DeepSeek's `reasoning_content` — is a
 * different kind of text from the answer and is shown in a different place, so
 * the two are kept apart from the moment they arrive rather than sorted out
 * later by looking for a marker inside one string.
 */
export type DeltaKind = 'answer' | 'reasoning'

/**
 * Streams one completion, feeding each delta to `onDelta`, and resolves with the
 * full text of the ANSWER — reasoning is delivered through `onDelta` and is
 * deliberately not part of the return value, because everything downstream (the
 * patch extractor, the history summary) is about what the model said, not about
 * how it got there. An aborted generation resolves with whatever arrived — the
 * student navigated away, that is not an error.
 */
export async function streamChat(
  messages: ChatTurn[],
  onDelta: (text: string, kind: DeltaKind) => void,
  signal?: AbortSignal,
  /**
   * Сколько токенов ушло, если провайдер сказал.
   *
   * Просить об этом надо явно — `stream_options.include_usage`, — и раньше
   * никто не просил: столбец в таблице оставался пустым, а панель писала
   * «tokens — not reported by this endpoint», хотя не рассказывал не он.
   * Приходит одним последним кадром, уже без выбора.
   */
  onUsage?: (totalTokens: number) => void,
): Promise<string> {
  // Reaches a student verbatim, so it names what is missing rather than an
  // environment variable they have no way to set.
  if (!providerReady()) throw new Error('No model is set up on this Colloq yet.')
  if (signal?.aborted) return ''

  const payload = toPayload(messages)
  let stream: Awaited<ReturnType<typeof openStream>>
  try {
    stream = await openStream(payload, 0.3, signal, askForReasoning())
  } catch (err) {
    if (isAbort(err, signal)) return ''
    /*
     * Retry with nothing but the message list. Three different endpoints refuse
     * three different extras — a reasoning-style model rejects any temperature
     * but its default, an endpoint that has never heard of `reasoning` rejects
     * that, and a gateway with a strict schema rejects `stream_options` — and a
     * seminar does not care which of the three it hit. The bare call is the one
     * every OpenAI-compatible endpoint honours, which is the whole premise of
     * this module.
     *
     * «Голая» здесь значит голая. Она однажды не была: `stream_options` ехало в
     * обе попытки, так что шлюз, отвергающий именно его, получал 400 дважды и
     * оракул на нём не работал вовсе — при том, что комментарий над `usage`
     * обещал ровно этот случай вылечить. Цена голой попытки — расход в токенах
     * по ней не приедет; в панели такая строка останется без числа, и это лучше,
     * чем красная ошибка вместо ответа.
     */
    if (isBadRequest(err)) {
      try {
        stream = await openStream(payload, undefined, signal, false, true)
      } catch (retryErr) {
        if (isAbort(retryErr, signal)) return ''
        throw friendly(retryErr)
      }
    } else {
      throw friendly(err)
    }
  }

  let full = ''
  try {
    for await (const chunk of stream) {
      // Кадр с расходом приходит последним и без choices — его надо забрать до
      // того, как код ниже полезет в delta, которой в нём нет.
      const spent = (chunk as { usage?: { total_tokens?: number } | null }).usage
      if (spent && typeof spent.total_tokens === 'number') onUsage?.(spent.total_tokens)
      const delta = chunk.choices?.[0]?.delta as Delta | undefined
      /*
       * Two spellings because two families of endpoint. OpenRouter puts the
       * trace in `reasoning`; DeepSeek and the runtimes that copied it use
       * `reasoning_content`. Neither is in the OpenAI SDK's types, which is why
       * the delta is widened above rather than read through them.
       */
      const thinking = delta?.reasoning ?? delta?.reasoning_content
      if (typeof thinking === 'string' && thinking) onDelta(thinking, 'reasoning')
      const said = delta?.content
      if (typeof said === 'string' && said) {
        full += said
        onDelta(said, 'answer')
      }
    }
  } catch (err) {
    if (isAbort(err, signal)) return full
    throw friendly(err)
  }
  return full
}

/**
 * The delta as it actually arrives, rather than as the SDK types it.
 *
 * Reasoning is not in the OpenAI schema, so it is not in the SDK's types
 * either; an endpoint that sends it sends it anyway. Widening here keeps the
 * cast in one place and out of the read loop.
 */
interface Delta {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
}

type PayloadTurn =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }

/** The SDK's message type is a discriminated union, so widen role by hand. */
function toPayload(messages: ChatTurn[]): PayloadTurn[] {
  return messages.map((turn) =>
    turn.role === 'system'
      ? { role: 'system' as const, content: turn.content }
      : turn.role === 'assistant'
        ? { role: 'assistant' as const, content: turn.content }
        : { role: 'user' as const, content: turn.content },
  )
}

/**
 * Whether to ask this endpoint to show its work.
 *
 * Only OpenRouter, and only because it is the one provider here with a
 * documented switch for it. Everywhere else the trace is taken if it is
 * volunteered and never requested: sending a field an endpoint has not heard of
 * to trade a nicety for a 400 in front of a class is not a trade worth making.
 */
function askForReasoning(): boolean {
  /*
   * Выключено, пока не попросят.
   *
   * Было «всегда на OpenRouter», и это тихо удваивало счёт: у рассуждающих
   * моделей след стоит как ответ, а иногда дороже, и его просили на каждый
   * вопрос — включая «объясни эту ошибку», где думать нечего. След остаётся
   * виден, когда провайдер отдаёт его сам; здесь только про то, доплачивать ли
   * за него отдельно.
   */
  return resolveAiConfig().provider === 'openrouter' && config.ai.reasoning
}

function openStream(
  messages: PayloadTurn[],
  temperature: number | undefined,
  signal: AbortSignal | undefined,
  reasoning: boolean,
  /** Голая повторная попытка: ничего сверх списка сообщений — см. streamChat. */
  bare = false,
) {
  const model = resolveAiConfig().model
  // `reasoning` is OpenRouter's own field, so it is not in the SDK's params
  // type; the cast is at this one call site rather than on the config object.
  const extra = reasoning ? ({ reasoning: { enabled: true } } as Record<string, unknown>) : {}
  // Two call sites rather than one params object: `stream: true` has to be a
  // literal for the SDK to pick its streaming overload.
  /*
   * Расход — отдельной просьбой.
   *
   * Поле из спецификации OpenAI, и его понимают все, кто ей следует; кто не
   * понимает — ответит 400, и тогда сработает голая попытка (streamChat), в
   * которой этого поля уже нет. Плата за попытку — один лишний кадр в потоке.
   */
  const usage = bare ? {} : { stream_options: { include_usage: true } }
  return temperature === undefined
    ? getClient().chat.completions.create(
        { model, messages, stream: true, ...usage, ...extra },
        { signal },
      )
    : getClient().chat.completions.create(
        { model, messages, stream: true, temperature, ...usage, ...extra },
        { signal },
      )
}

/**
 * Один ход с инструментами — без потока.
 *
 * Поток здесь не нужен и был бы вреден: аргументы инструмента приезжают в
 * потоке по кускам незавершённого JSON, и собирать его обратно приходится
 * по-разному у разных провайдеров — ровно та зависимость от конкретного
 * эндпоинта, которой этот модуль избегает. Видимый прогресс у режима «сделать»
 * даёт лента шагов, а не набегающие буквы: «прочитал src/model.py» полезнее
 * половины предложения.
 *
 * `tools` пустой — обычный ход без инструментов; так же зовётся последний шаг,
 * когда агент уже всё сделал и осталось только сказать словами.
 */
export async function completeWithTools(
  messages: ChatTurn[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  onUsage?: (totalTokens: number) => void,
): Promise<{ text: string; calls: ToolCall[] }> {
  if (!providerReady()) throw new Error('No model is set up on this Colloq yet.')
  const model = resolveAiConfig().model
  const payload = {
    model,
    messages: toToolPayload(messages),
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: 'auto' as const,
        }
      : {}),
  }
  let answer
  try {
    answer = await getClient().chat.completions.create(payload as never, { signal })
  } catch (err) {
    if (isAbort(err, signal)) return { text: '', calls: [] }
    /*
     * Эндпоинт, который не умеет инструменты, отвечает 400 — и это не поломка,
     * а свойство того, куда указали. Отдельная фраза, потому что «сделать» на
     * такой модели не заработает никогда, сколько ни повторяй, а «спросить»
     * работает прекрасно.
     *
     * Но 400 у агента бывает и по другой причине: переписка растёт на каждый
     * прочитанный файл, и небольшое окно переполняется на третьем шаге. Тогда
     * эта фраза — враньё: инструментами только что пользовались. Отличаем по
     * самой переписке (в ней уже есть ответы инструментов) и по словам
     * эндпоинта, а в остальных случаях 400 показывается как есть, с деталью.
     */
    if (isBadRequest(err) && tools.length > 0 && !usedTools(messages) && !aboutSize(err)) {
      throw new Error(
        'Модель отклонила запрос с инструментами. ' +
          'Попробуйте режим вопроса.',
      )
    }
    throw friendly(err)
  }
  const spent = (answer as { usage?: { total_tokens?: number } | null }).usage
  if (spent && typeof spent.total_tokens === 'number') onUsage?.(spent.total_tokens)
  const choice = (answer as { choices?: Array<{ message?: RawMessage }> }).choices?.[0]?.message
  const calls: ToolCall[] = []
  for (const call of choice?.tool_calls ?? []) {
    if (!call?.function?.name) continue
    calls.push({
      id: typeof call.id === 'string' ? call.id : `call_${calls.length}`,
      name: call.function.name,
      args: typeof call.function.arguments === 'string' ? call.function.arguments : '{}',
    })
  }
  return { text: typeof choice?.content === 'string' ? choice.content : '', calls }
}

/** Инструментами в этом ходе уже пользовались — значит, эндпоинт их умеет. */
function usedTools(messages: ChatTurn[]): boolean {
  return messages.some((turn) => turn.callId !== undefined || (turn.calls?.length ?? 0) > 0)
}

/** Похоже ли, что эндпоинт жалуется на размер запроса, а не на его форму. */
function aboutSize(err: unknown): boolean {
  return /context|too long|maximum|token/i.test(detailOf(err))
}

/** Сообщение, как его правда присылают: `tool_calls` нет в типах SDK для этой формы. */
interface RawMessage {
  content?: string | null
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>
}

function toToolPayload(messages: ChatTurn[]): unknown[] {
  return messages.map((turn) => {
    if (turn.role === 'assistant' && turn.calls && turn.calls.length > 0) {
      return {
        role: 'assistant',
        content: turn.content || null,
        tool_calls: turn.calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.args },
        })),
      }
    }
    if (turn.callId) return { role: 'tool', tool_call_id: turn.callId, content: turn.content }
    return { role: turn.role, content: turn.content }
  })
}

/* ------------------------------------------------------------------ test */

/**
 * The cheapest call that proves the whole path works: a real one-token
 * completion, against the model that will actually answer students. A reachable
 * host with a valid key and a model nobody has pulled yet is the single most
 * common misconfiguration, and only a real request finds it.
 *
 * Where the completion is rejected outright we fall back to GET /models, which
 * separates "this endpoint is fine, my request was not" from "this endpoint has
 * never heard of that model" — three failures, three different sentences,
 * because "test failed" tells a teacher with a class waiting nothing.
 */
export async function testConnection(): Promise<OracleTestResult> {
  const ai = resolveAiConfig()
  if (!ai.baseUrl) return fail('No endpoint address is set — choose a provider or type a base URL.')
  if (!ai.model)
    return fail('No model is set — type the name the endpoint expects, e.g. gpt-4o-mini.')
  if (!ai.apiKey && !isKeylessProvider(ai.provider)) {
    return fail(
      'No API key is set — paste one, or switch the provider to a local runtime that does not need one.',
    )
  }

  const began = Date.now()
  try {
    const completion = await getClient().chat.completions.create(
      { model: ai.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
      ONE_TRY,
    )
    const ms = Date.now() - began
    const model = completion.model || ai.model
    return { ok: true, ms, message: `Answered in ${ms} ms as "${model}".`, model }
  } catch (err) {
    return diagnose(err, ai.model, ai.baseUrl)
  }
}

async function diagnose(err: unknown, model: string, baseUrl: string): Promise<OracleTestResult> {
  const status = statusOf(err)
  const detail = detailOf(err)

  if (status === 401 || status === 403) {
    return fail(
      `${baseUrl} denied access. Check the API key and account permissions.`,
    )
  }
  if (status === 429) {
    return fail(
      'The endpoint returned HTTP 429. Check the account quota and request limits.',
    )
  }
  if (status !== null && status >= 500) {
    return fail(
      `${baseUrl} answered with a server error (${status}). Try again later.`,
    )
  }
  if (status === 400 || status === 404 || status === 422) {
    return await afterRejection(model, baseUrl, status, detail)
  }
  if (status !== null) {
    return fail(`${baseUrl} refused the request (${status}). ${detail}`.trim())
  }
  /*
   * Отказ фильтра бывает и здесь — и лечится он не адресом.
   *
   * Пробная просьба короткая («ping»), так что до этой ветки доходит редко; но
   * если дошло, «не смог достучаться до <адрес>» — это ровно та ложь, из-за
   * которой преподаватель идёт чинить сеть при исправной сети.
   */
  if (isRefusal(err)) {
    return fail(
      `${baseUrl} returned a model refusal for the test request.`,
    )
  }
  // No status at all: nothing answered, so this is the address or the network.
  const code = causeCode(err)
  if (isTimeout(err)) {
    return fail(
      `${baseUrl} did not answer within ${TEST_TIMEOUT_MS / 1000} seconds. Is it running, and reachable from the Colloq container?`,
    )
  }
  return fail(
    `Could not reach ${baseUrl}${code ? ` (${code})` : ''}. Check the address — a local runtime needs a host the server can see, not localhost inside a container.`,
  )
}

/** The completion was rejected; ask the endpoint what it does have. */
async function afterRejection(
  model: string,
  baseUrl: string,
  status: number,
  detail: string,
): Promise<OracleTestResult> {
  const began = Date.now()
  let models: string[]
  try {
    const page = await getClient().models.list(ONE_TRY)
    models = page.data.map((entry) => entry.id)
  } catch (listErr) {
    const listStatus = statusOf(listErr)
    if (listStatus === 401 || listStatus === 403) {
      return fail(
        `${baseUrl} denied access. Check the API key and account permissions.`,
      )
    }
    if (status === 404) {
      return fail(
        `${baseUrl} returned HTTP 404 for the test request, and the model list could not be read. Check the base URL and model name.`,
      )
    }
    return fail(`${baseUrl} refused the request: ${detail || `HTTP ${status}`}`)
  }

  const ms = Date.now() - began
  if (models.length > 0 && !models.includes(model)) {
    const offered = models.slice(0, 6).join(', ')
    return {
      ok: false,
      ms: null,
      message: `${baseUrl} does not list "${model}". Listed models: ${offered}${models.length > 6 ? ', …' : ''}.`,
      model: null,
    }
  }
  // The endpoint answers and knows the model, but would not take our test call —
  // some gateways refuse max_tokens: 1, which says nothing about real questions.
  return {
    ok: true,
    ms,
    message: `${baseUrl} returned a model list but rejected the test request for "${model}"${detail ? ` (${detail})` : ''}. A successful model response has not been verified.`,
    model,
  }
}

function fail(message: string): OracleTestResult {
  return { ok: false, ms: null, message, model: null }
}

function statusOf(err: unknown): number | null {
  const status = (err as { status?: number } | null)?.status
  return typeof status === 'number' ? status : null
}

function detailOf(err: unknown): string {
  const message = (err as { message?: string } | null)?.message
  if (typeof message !== 'string' || !message) return ''
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…` : flat
}

function causeCode(err: unknown): string {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof code === 'string' ? code : ''
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name
  return name === 'APIConnectionTimeoutError' || causeCode(err) === 'ETIMEDOUT'
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  const name = (err as { name?: string } | null)?.name
  return name === 'AbortError' || name === 'APIUserAbortError'
}

function isBadRequest(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 400
}

/**
 * Модель отказалась отвечать — сработал её фильтр, а не сеть и не ключ.
 *
 * Так это приезжает на самом деле. Отказ по безопасности у Gemini через
 * OpenAI-совместимый шлюз приходит НЕ статусом: кадр потока несёт поле `error`,
 * и SDK на нём бросает `new APIError(undefined, data.error, …)` (openai
 * streaming.mjs) — то есть ошибку БЕЗ status, с одним лишь текстом. В журнале
 * это выглядело как `no response — SAFETY`, а `friendly` не находил ни одной
 * подходящей ветки и отвечал последней, про адрес и ключ.
 *
 * Смотрим на всё, чем разные шлюзы это называют: собственный класс SDK
 * (`ContentFilterFinishReasonError`), `code`/`type` ответа, причина остановки в
 * теле и, последним, слова в самом сообщении — «SAFETY» приезжает именно так.
 */
function isRefusal(err: unknown): boolean {
  const failed = err as
    | {
        code?: unknown
        type?: unknown
        error?: { code?: unknown; type?: unknown; status?: unknown; finish_reason?: unknown }
      }
    | null
    | undefined
  // По классу, а не по `name`: у ошибок этого SDK `name` всегда «Error» —
  // проверено на openai@4.104, — и `isTimeout` рядом ловит свой случай только
  // вторым условием, про код причины.
  if (className(err) === 'ContentFilterFinishReasonError') return true
  const words = [
    failed?.code,
    failed?.type,
    failed?.error?.code,
    failed?.error?.type,
    failed?.error?.status,
    failed?.error?.finish_reason,
  ]
  for (const word of words) {
    if (typeof word !== 'string') continue
    if (/^(safety|blocked|content[_-]?filter|prohibited|recitation)/i.test(word)) return true
  }
  // Слова эндпоинта — последними: у 400 «bad request» их тоже хватает, и
  // выхватывать «safety» из середины чужого предложения было бы гаданием.
  return REFUSAL_WORDS.test(detailOf(err))
}

/**
 * Слова, которыми это называют вслух. Границы слова обязательны: «safety» —
 * отказ, а «safety_settings» в жалобе на параметр запроса — не он.
 */
const REFUSAL_WORDS =
  /\b(safety|content[ _-]?filter|content[ _-]?policy|blocked by|recitation|prohibited[ _-]?content)\b/i

/**
 * Эндпоинт ответил, а потом оборвался — но это не «до него не достучались».
 *
 * У ошибки, родившейся ВНУТРИ потока, статуса нет: SDK строит её напрямую,
 * минуя `APIError.generate`, — и по одному отсутствию статуса такая ошибка
 * неотличима от `APIConnectionError`, которую тот же SDK выдаёт, когда до хоста
 * не доехал ни один байт. Различает их имя класса: соединение, которое не
 * состоялось, зовётся APIConnection*, всё остальное — уже разговор.
 */
function answeredThenBroke(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  // APIConnectionError наследует APIError, и вот она-то и есть «не достучались».
  if (err instanceof OpenAI.APIConnectionError) return false
  return typeof err.status !== 'number'
}

/** Класс ошибки по имени конструктора: `name` у этого SDK не отличает ничего. */
function className(err: unknown): string {
  const ctor = (err as { constructor?: { name?: unknown } } | null)?.constructor
  return typeof ctor?.name === 'string' ? ctor.name : ''
}

/** Raw SDK errors carry request internals; hand back something readable instead. */
function friendly(err: unknown): Error {
  const status = (err as { status?: number } | null)?.status
  const ai = resolveAiConfig()
  /*
   * The original message goes to the log and nowhere else. It carries request
   * internals, and the sentence a student reads is written below — but without
   * this line a failing oracle left the operator nothing at all to look at.
   */
  const refused = isRefusal(err)
  tally('oracle')
  console.warn(
    '[ai] request failed',
    status ? `status ${status}` : refused ? 'refused by the model' : 'no response',
    err instanceof Error ? `— ${err.message}` : '',
  )

  /*
   * Отказ фильтра — первым, потому что он приходит и со статусом, и без.
   *
   * Это тот случай, который стоил живой паре получаса: шлюз с Gemini пять раз
   * подряд ответил «SAFETY» без HTTP-статуса, а комната прочитала «не удалось
   * достучаться, проверьте адрес и ключ» — и преподаватель пошёл чинить сеть и
   * ключ, оба совершенно здоровые. Адрес и ключ здесь не называются вовсе: они
   * ни при чём, а человеку в комнате их всё равно не видно.
   */
  if (refused) {
    return new Error(
      'The model declined this request.',
    )
  }

  /*
   * A timeout is not "could not reach". With one retry in the SDK the real
   * wait is about four minutes, and the room was told the endpoint was
   * unreachable — which sends a teacher to check the network rather than the
   * model, and is wrong: the endpoint answered, slowly.
   */
  if (isTimeout(err)) {
    return new Error(
      'The model did not respond within the time limit. Try again.',
    )
  }

  if (status === 401 || status === 403) {
    return new Error(
      'The AI provider denied access. Ask the Colloq administrator to check the API key and account permissions.',
    )
  }
  if (status === 404) {
    return new Error(`The AI endpoint returned HTTP 404 for "${ai.model}". Ask the Colloq administrator to check the endpoint address and model name.`)
  }
  if (status === 400) {
    // The endpoint's own words: a 400 is almost always a real reason — an
    // unsupported parameter, a context that does not fit — and hiding it left
    // the one person who could act on it guessing.
    const detail = detailOf(err)
    return new Error(
      detail
        ? `The AI endpoint rejected the request for model "${ai.model}": ${detail}`
        : `The AI endpoint rejected the request for model "${ai.model}".`,
    )
  }
  if (status === 429) {
    return new Error('The AI provider returned HTTP 429. Its request limit or account quota may have been reached. Try later or ask the Colloq administrator to check.')
  }
  if (status !== undefined && status >= 500) {
    return new Error('The AI endpoint returned a server error.')
  }
  /*
   * Ответил и оборвался — тоже не «не достучались».
   *
   * Статуса у такой ошибки нет, и до этой правки она попадала в последнюю
   * ветку, то есть отправляла человека проверять адрес и ключ, к которым
   * только что успешно сходили. Слова эндпоинта здесь показываются: это
   * единственное, что вообще известно о происшедшем.
   */
  if (answeredThenBroke(err)) {
    const detail = detailOf(err)
    return new Error(
      detail
        ? `The AI endpoint broke off mid-answer: ${detail}`
        : 'The model response was interrupted. Try again.',
    )
  }
  /*
   * The address is not shown. It is the operator's configuration, sometimes an
   * internal host, and the student reading this cannot act on it either way.
   */
  return new Error(
    'Could not reach the AI endpoint. Whoever runs this Colloq can check its address and key.',
  )
}
