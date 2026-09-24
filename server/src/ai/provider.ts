import { tr } from '@shared/i18n'
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
import {
  isKeylessProvider,
  providerConfigured,
  type AiProviderId,
  type OracleTestResult,
  type ReasoningEffort,
} from '@shared/admin'

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Tools the model asked to run in this turn. */
  calls?: ToolCall[]
  /** A tool's reply: it has an addressee — the call it answers. */
  callId?: string
}

/** One tool call: the name and the arguments as the model sent them. */
export interface ToolCall {
  id: string
  name: string
  /** JSON as a string, exactly as received; the caller parses it and owns bad input. */
  args: string
}

/** A tool description in the form an OpenAI-compatible endpoint understands. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A teacher pressed a button and is watching a spinner; the seminar timeout is far too long for that. */
const TEST_TIMEOUT_MS = 20_000

/**
 * The probe runs exactly once, and that is the whole point of the deadline.
 *
 * The client is set up with `maxRetries: 1`, and the SDK retries connection
 * timeouts too: under a "black hole" the probe waited twice for twenty seconds
 * and answered "did not answer within 20 seconds". The teacher watched the
 * spinner for forty seconds and read about twenty. A retry is not needed here
 * anyway: the button is pressed by hand, and so is pressing it again.
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
  // The rule lives in shared and only there: the panel computes the room's
  // ceiling with the same function (web/src/admin/panel.ts), and when the
  // server had its own copy, the two drifted apart — with Ollama configured the
  // screen disabled the modes while the oracle answered.
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
   * How many tokens were spent, if the provider said.
   *
   * This has to be asked for explicitly — `stream_options.include_usage` — and
   * before, nobody asked: the column in the table stayed empty, and the panel
   * said "tokens — not reported by this endpoint", although it was not the
   * endpoint that kept quiet. Arrives as one last frame, with no choices.
   */
  onUsage?: (totalTokens: number) => void,
  /**
   * How much to think out loud. `undefined`/`normal` means sending the provider
   * nothing new: an instance where nobody touched this knob must go to the
   * model with the same request as before the knob existed.
   */
  effort?: ReasoningEffort,
): Promise<string> {
  // Reaches a student verbatim, so it names what is missing rather than an
  // environment variable they have no way to set.
  if (!providerReady()) throw new Error(tr("server.noModelIsSetUpOnThis.1152ef"))
  if (signal?.aborted) return ''

  const payload = toPayload(messages)
  let stream: Awaited<ReturnType<typeof openStream>>
  try {
    stream = await openStream(payload, 0.3, signal, askForReasoning(), false, effort)
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
     * "Bare" here means bare. Once it was not: `stream_options` went into both
     * attempts, so a gateway rejecting exactly that field got a 400 twice and
     * the oracle did not work on it at all — while the comment above `usage`
     * promised to cure precisely this case. The price of the bare attempt is
     * that its token usage will not arrive; in the panel such a row stays
     * without a number, and that is better than a red error instead of an
     * answer.
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
      // The usage frame comes last and without choices — it has to be picked up
      // before the code below reaches for a delta that is not in it.
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
   * Off until asked for.
   *
   * It used to be "always on OpenRouter", and that quietly doubled the bill:
   * for reasoning models the trace costs as much as the answer, sometimes more,
   * and it was requested on every question — including "explain this error",
   * where there is nothing to think about. The trace stays visible when the
   * provider hands it over on its own; this is only about whether to pay extra
   * for it.
   */
  return resolveAiConfig().provider === 'openrouter' && config.ai.reasoning
}

/**
 * The reasoning level, in the language of a specific provider.
 *
 * Each has its own and none is shared: OpenRouter understands the `reasoning`
 * field (`enabled`, `effort`, `exclude`), OpenAI `reasoning_effort`, the rest
 * understand nothing, and they are sent NOTHING. This is not laziness: an
 * unfamiliar field on a strict gateway is a 400 in the middle of a class,
 * while "instant" works even without a field, because next to it in the
 * system frame stands the same request in words (ai/text.ts · effortNote).
 *
 * `normal` sends nothing EITHER — and that is the knob's main property: an
 * instance where it was not touched goes to the model with exactly the same
 * request as before it.
 *
 * An important caveat about models whose reasoning cannot be switched off
 * (DeepSeek R1 and its kin): they accept `reasoning: { enabled: false }`, but
 * they will think anyway — for them it is not a mode but how they are built.
 * "Instant" on such a model gives a short answer (through the request in the
 * frame) but not a fast one; a fast one is a different model, and that is
 * chosen in the panel, not here.
 */
function thinkingFields(reasoning: boolean, effort?: ReasoningEffort): Record<string, unknown> {
  const provider: AiProviderId = resolveAiConfig().provider
  if (provider === 'openrouter') {
    if (effort === 'instant') return { reasoning: { enabled: false } }
    if (effort === 'deep') return { reasoning: { effort: 'high' } }
    return reasoning ? { reasoning: { enabled: true } } : {}
  }
  if (provider === 'openai') {
    // 'minimal' is the lowest step for models that know it; those that do not
    // will answer 400, and the bare retry kicks in (see streamChat).
    if (effort === 'instant') return { reasoning_effort: 'minimal' }
    if (effort === 'deep') return { reasoning_effort: 'high' }
    return {}
  }
  return {}
}

function openStream(
  messages: PayloadTurn[],
  temperature: number | undefined,
  signal: AbortSignal | undefined,
  reasoning: boolean,
  /** The bare retry: nothing beyond the message list — see streamChat. */
  bare = false,
  effort?: ReasoningEffort,
) {
  const model = resolveAiConfig().model
  // `reasoning` is OpenRouter's own field, so it is not in the SDK's params
  // type; the cast is at this one call site rather than on the config object.
  const extra = bare ? {} : thinkingFields(reasoning, effort)
  // Two call sites rather than one params object: `stream: true` has to be a
  // literal for the SDK to pick its streaming overload.
  /*
   * Usage as a separate request.
   *
   * A field from the OpenAI spec, understood by everyone who follows it; those
   * who do not will answer 400, and then the bare attempt kicks in
   * (streamChat), which no longer has this field. The cost of asking is one
   * extra frame in the stream.
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
 * The answer ceiling on the tools path.
 *
 * Named rather than left to the endpoint's discretion: their defaults differ
 * and are sometimes tiny, and a truncated answer on this path is an unfinished
 * call JSON, which parses into "the arguments did not come as JSON", that is,
 * a turn step spent on someone else's default. Eight thousand leaves room for
 * the longest call (`write_file` with a whole file).
 */
const MAX_TOOL_TOKENS = 8_000

/**
 * One turn with tools — without streaming.
 *
 * Streaming is not needed here and would do harm: tool arguments arrive in the
 * stream as pieces of incomplete JSON, and reassembling them has to be done
 * differently for different providers — exactly the dependence on a specific
 * endpoint that this module avoids. Visible progress in the "Act" mode comes
 * from the feed of steps, not from letters trickling in: "read src/model.py"
 * is more useful than half a sentence.
 *
 * Empty `tools` is an ordinary turn without tools; the last step is called the
 * same way, when the agent has already done everything and all that is left is
 * to say it in words.
 */
export async function completeWithTools(
  messages: ChatTurn[],
  tools: ToolSpec[],
  signal?: AbortSignal,
  onUsage?: (totalTokens: number) => void,
  effort?: ReasoningEffort,
): Promise<{ text: string; reasoning: string; calls: ToolCall[] }> {
  const nothing = { text: '', reasoning: '', calls: [] }
  if (!providerReady()) throw new Error(tr("server.noModelIsSetUpOnThis.1152ef"))
  const model = resolveAiConfig().model
  const payload = {
    model,
    messages: toToolPayload(messages),
    max_tokens: MAX_TOOL_TOKENS,
    // The same temperature as for answering a question: a turn is the same
    // model and the same work, and there is no reason for the two paths to differ.
    temperature: 0.3,
    // The reasoning level is the same as for a question: "Act" differs from
    // "Ask" by its tools, not by how much the model thinks.
    ...thinkingFields(false, effort),
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
    if (isAbort(err, signal)) return nothing
    /*
     * The bare attempt — the same as the stream's, and for the same reason.
     *
     * A reasoning model rejects any temperature but its own, and a strict
     * gateway rejects an unfamiliar field; both answer 400. While this was
     * missing here, a turn on such an endpoint never started at all — while
     * questions on it went perfectly, and this was explained by the phrase
     * "the model cannot do tools", which was untrue. The tools stay in the bare
     * attempt: without them it is not the request that was asked for.
     *
     * We do not retry over size: an overflowing window will overflow on the
     * second attempt in exactly the same way, and an extra request is extra
     * money and an extra half-minute.
     */
    if (!isBadRequest(err) || aboutSize(err)) throw friendly(err)
    // The bare attempt is bare in this too: the reasoning level field goes
    // along with the temperature and the ceiling — an unfamiliar field is the
    // most common cause of a 400.
    const {
      max_tokens: _tokens,
      temperature: _heat,
      reasoning: _reasoning,
      reasoning_effort: _effort,
      ...bare
    } = payload as typeof payload & { reasoning?: unknown; reasoning_effort?: unknown }
    try {
      answer = await getClient().chat.completions.create(bare as never, { signal })
    } catch (retryErr) {
      if (isAbort(retryErr, signal)) return nothing
      /*
       * An endpoint that cannot do tools answers 400 — and that is not a
       * breakage but a property of where it was pointed. A separate phrase,
       * because "Act" will never work on such a model, however often you
       * retry, while "Ask" works perfectly.
       *
       * But an agent's 400 also happens for another reason: the conversation
       * grows with every file read, and a small window overflows on the third
       * step. Then this phrase is a lie: the tools were just being used. We
       * tell the cases apart by the conversation itself (it already has tool
       * replies) and by the endpoint's words, and in other cases the 400 is
       * shown as is, with the detail.
       */
      if (
        isBadRequest(retryErr) &&
        tools.length > 0 &&
        !usedTools(messages) &&
        !aboutSize(retryErr)
      ) {
        throw new Error(
          tr("server.theModelRejectedTheRequestWithTools.c6fde5") +
            tr("server.tryAskingAQuestionInstead.a2a998"),
        )
      }
      throw friendly(retryErr)
    }
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
  const text = typeof choice?.content === 'string' ? choice.content : ''
  /*
   * The reasoning trace — in the same two spellings as in the stream.
   *
   * It was read only in the stream and lost here entirely, and that cost more
   * than looks: for reasoning models the whole answer goes into `reasoning`
   * while `content` comes back empty — and a turn that asked only for `content`
   * saw emptiness and ended with an empty caption under the feed of steps. The
   * caller decides what to do with it; the job here is only not to lose it.
   */
  const reasoning =
    typeof choice?.reasoning === 'string'
      ? choice.reasoning
      : typeof choice?.reasoning_content === 'string'
        ? choice.reasoning_content
        : ''
  return { text, reasoning, calls: calls.length > 0 ? calls : callsInText(text, tools) }
}

/**
 * A call written in the text instead of the `tool_calls` field.
 *
 * Small models — and any model on a gateway that lost `tools` along the way —
 * answer a request to call a tool with a JSON object in the text:
 * `{"name": "read_file", "arguments": {"path": "train.py"}}`, sometimes inside
 * a ```json fence. That does not become a call, and the turn ended with an
 * answer in which the model describes what it is about to do — with the same
 * two-step feed that all of this is being fixed for.
 *
 * Parsed only when there are NO real calls and only for a known tool name:
 * JSON in an answer can be plain data, and taking a piece of data for a call
 * means doing something nobody asked for.
 */
function callsInText(text: string, tools: ToolSpec[]): ToolCall[] {
  const trimmed = text.trim()
  if (!trimmed || tools.length === 0) return []
  const names = new Set(tools.map((tool) => tool.name))
  const fenced = /```(?:json|tool_call|tool_calls)?\s*([\s\S]*?)```/i.exec(trimmed)
  const source = (fenced ? fenced[1] : trimmed).trim()
  if (!source.startsWith('{') && !source.startsWith('[')) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return []
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.tool_calls)
      ? parsed.tool_calls
      : [parsed]
  const calls: ToolCall[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const body = isRecord(row.function) ? row.function : row
    const name = body.name
    if (typeof name !== 'string' || !names.has(name)) continue
    const args = body.arguments ?? body.parameters ?? body.args ?? {}
    calls.push({
      id: `text_${calls.length}`,
      name,
      args: typeof args === 'string' ? args : JSON.stringify(args),
    })
  }
  return calls
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Tools were already used in this turn — so the endpoint can do them. */
function usedTools(messages: ChatTurn[]): boolean {
  return messages.some((turn) => turn.callId !== undefined || (turn.calls?.length ?? 0) > 0)
}

/** Does it look like the endpoint complains about the request's size, not its shape. */
function aboutSize(err: unknown): boolean {
  return /context|too long|maximum|token/i.test(detailOf(err))
}

/** The message as it is really sent: the SDK types lack `tool_calls` for this shape. */
interface RawMessage {
  content?: string | null
  /** OpenRouter puts the trace here; DeepSeek and its imitators use `reasoning_content`. */
  reasoning?: string | null
  reasoning_content?: string | null
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
  if (!ai.baseUrl) return fail(tr("server.noEndpointAddressIsSetChooseA.93a30c"))
  if (!ai.model)
    return fail(tr("server.noModelIsSetTypeTheName.dce34d"))
  if (!ai.apiKey && !isKeylessProvider(ai.provider)) {
    return fail(
      tr("server.noApiKeyIsSetPasteOne.d5a86a"),
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
    return { ok: true, ms, message: tr("server.answeredInMsAs.81b232", { p0: ms, p1: model }), model }
  } catch (err) {
    return diagnose(err, ai.model, ai.baseUrl)
  }
}

async function diagnose(err: unknown, model: string, baseUrl: string): Promise<OracleTestResult> {
  const status = statusOf(err)
  const detail = detailOf(err)

  if (status === 401 || status === 403) {
    return fail(
      tr("server.deniedAccessCheckTheApiKeyAnd.302b39", { p0: baseUrl }),
    )
  }
  if (status === 429) {
    return fail(
      tr("server.theEndpointReturnedHttpCheckTheAccount.346fd1"),
    )
  }
  if (status !== null && status >= 500) {
    return fail(
      tr("server.answeredWithAServerErrorTryAgain.9430de", { p0: baseUrl, p1: status }),
    )
  }
  if (status === 400 || status === 404 || status === 422) {
    return await afterRejection(model, baseUrl, status, detail)
  }
  if (status !== null) {
    return fail(tr("server.refusedTheRequest.85f159", { p0: baseUrl, p1: status, p2: detail }).trim())
  }
  /*
   * A filter refusal happens here too — and it is not cured by the address.
   *
   * The test request is short ("ping"), so this branch is rarely reached; but
   * if it is, "could not reach <address>" is exactly the lie that sends a
   * teacher to fix the network while the network is fine.
   */
  if (isRefusal(err)) {
    return fail(
      tr("server.returnedAModelRefusalForTheTest.74f8ac", { p0: baseUrl }),
    )
  }
  // No status at all: nothing answered, so this is the address or the network.
  const code = causeCode(err)
  if (isTimeout(err)) {
    return fail(
      tr("server.didNotAnswerWithinSecondsIsIt.dcedf5", { p0: baseUrl, p1: TEST_TIMEOUT_MS / 1000 }),
    )
  }
  return fail(
    tr("server.couldNotReachCheckTheAddressA.a531ef", { p0: baseUrl, p1: code ? ` (${code})` : '' }),
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
        tr("server.deniedAccessCheckTheApiKeyAnd.302b39", { p0: baseUrl }),
      )
    }
    if (status === 404) {
      return fail(
        tr("server.returnedHttpForTheTestRequestAnd.2b8b64", { p0: baseUrl }),
      )
    }
    return fail(tr("server.refusedTheRequest.1dca50", { p0: baseUrl, p1: detail || `HTTP ${status}` }))
  }

  const ms = Date.now() - began
  if (models.length > 0 && !models.includes(model)) {
    const offered = models.slice(0, 6).join(', ')
    return {
      ok: false,
      ms: null,
      message: tr("server.doesNotListListedModels.915980", { p0: baseUrl, p1: model, p2: offered, p3: models.length > 6 ? ', …' : '' }),
      model: null,
    }
  }
  // The endpoint answers and knows the model, but would not take our test call —
  // some gateways refuse max_tokens: 1, which says nothing about real questions.
  return {
    ok: true,
    ms,
    message: tr("server.returnedAModelListButRejectedThe.2051f2", { p0: baseUrl, p1: model, p2: detail ? ` (${detail})` : '' }),
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
 * The model refused to answer — its filter fired, not the network and not the
 * key.
 *
 * This is how it really arrives. A safety refusal from Gemini through an
 * OpenAI-compatible gateway does NOT come as a status: a stream frame carries
 * an `error` field, and the SDK throws `new APIError(undefined, data.error, …)`
 * on it (openai streaming.mjs) — that is, an error WITHOUT a status, with
 * nothing but text. In the log it looked like `no response — SAFETY`, and
 * `friendly` found no matching branch and answered with the last one, about
 * the address and the key.
 *
 * We look at everything the different gateways call it: the SDK's own class
 * (`ContentFilterFinishReasonError`), the response's `code`/`type`, the stop
 * reason in the body and, last, words in the message itself — "SAFETY"
 * arrives exactly that way.
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
  // By class, not by `name`: this SDK's errors always have `name` "Error" —
  // checked on openai@4.104 — and `isTimeout` next door catches its case only
  // with its second condition, about the cause code.
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
  // The endpoint's words go last: a 400 "bad request" has plenty of them too,
  // and snatching "safety" out of the middle of someone else's sentence would
  // be guesswork.
  return REFUSAL_WORDS.test(detailOf(err))
}

/**
 * The words it is called out loud. Word boundaries are mandatory: "safety" is
 * a refusal, while "safety_settings" in a complaint about a request parameter
 * is not.
 */
const REFUSAL_WORDS =
  /\b(safety|content[ _-]?filter|content[ _-]?policy|blocked by|recitation|prohibited[ _-]?content)\b/i

/**
 * The endpoint answered and then broke off — but that is not "could not reach
 * it".
 *
 * An error born INSIDE the stream has no status: the SDK builds it directly,
 * bypassing `APIError.generate` — and by the absence of a status alone such an
 * error is indistinguishable from `APIConnectionError`, which the same SDK
 * gives when not a single byte reached the host. The class name tells them
 * apart: a connection that never happened is called APIConnection*, anything
 * else is already a conversation.
 */
function answeredThenBroke(err: unknown): boolean {
  if (!(err instanceof OpenAI.APIError)) return false
  // APIConnectionError extends APIError, and that one is exactly "could not reach".
  if (err instanceof OpenAI.APIConnectionError) return false
  return typeof err.status !== 'number'
}

/** The error class by constructor name: in this SDK `name` tells nothing apart. */
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
   * A filter refusal comes first, because it arrives both with a status and
   * without one.
   *
   * This is the case that cost a live class half an hour: a gateway with Gemini
   * answered "SAFETY" five times in a row without an HTTP status, and the room
   * read "could not reach it, check the address and the key" — and the teacher
   * went to fix the network and the key, both perfectly healthy. The address
   * and the key are not named here at all: they have nothing to do with it,
   * and the person in the room cannot see them anyway.
   */
  if (refused) {
    return new Error(
      tr("server.theModelDeclinedThisRequest.5e72c3"),
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
      tr("server.theModelDidNotRespondWithinThe.be1746"),
    )
  }

  if (status === 401 || status === 403) {
    return new Error(
      tr("server.theAiProviderDeniedAccessAskThe.31dbd6"),
    )
  }
  if (status === 404) {
    return new Error(tr("server.theAiEndpointReturnedHttpForAsk.56675a", { p0: ai.model }))
  }
  if (status === 400) {
    // The endpoint's own words: a 400 is almost always a real reason — an
    // unsupported parameter, a context that does not fit — and hiding it left
    // the one person who could act on it guessing.
    const detail = detailOf(err)
    return new Error(
      detail
        ? tr("server.theAiEndpointRejectedTheRequestFor.2dad2f", { p0: ai.model, p1: detail })
        : tr("server.theAiEndpointRejectedTheRequestFor.80fc8d", { p0: ai.model }),
    )
  }
  if (status === 429) {
    return new Error(tr("server.theAiProviderReturnedHttpItsRequest.7a3832"))
  }
  if (status !== undefined && status >= 500) {
    return new Error(tr("server.theAiEndpointReturnedAServerError.c7d0c1"))
  }
  /*
   * Answered and broke off — also not "could not reach".
   *
   * Such an error has no status, and before this fix it fell into the last
   * branch, that is, it sent a person to check the address and the key, which
   * had just been used successfully. The endpoint's words are shown here: they
   * are the only thing known about what happened at all.
   */
  if (answeredThenBroke(err)) {
    const detail = detailOf(err)
    return new Error(
      detail
        ? tr("server.theAiEndpointBrokeOffMidAnswer.d6573e", { p0: detail })
        : tr("server.theModelResponseWasInterruptedTryAgain.b5ba0f"),
    )
  }
  /*
   * The address is not shown. It is the operator's configuration, sometimes an
   * internal host, and the student reading this cannot act on it either way.
   */
  return new Error(
    tr("server.couldNotReachTheAiEndpointWhoever.5a0409"),
  )
}
