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
import { isKeylessProvider, resolveAiConfig } from '../admin/settings.js'
import type { OracleTestResult } from '@shared/admin'

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** A teacher pressed a button and is watching a spinner; the seminar timeout is far too long for that. */
const TEST_TIMEOUT_MS = 20_000

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
  return ai.apiKey.length > 0 || (isKeylessProvider(ai.provider) && ai.baseUrl.length > 0)
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
     * Retry with nothing but the message list. Two different endpoints refuse
     * two different extras — a reasoning-style model rejects any temperature
     * but its default, and an endpoint that has never heard of `reasoning`
     * rejects that — and a seminar does not care which of the two it hit. The
     * bare call is the one every OpenAI-compatible endpoint honours, which is
     * the whole premise of this module.
     */
    if (isBadRequest(err)) {
      try {
        stream = await openStream(payload, undefined, signal, false)
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
  return resolveAiConfig().provider === 'openrouter'
}

function openStream(
  messages: PayloadTurn[],
  temperature: number | undefined,
  signal: AbortSignal | undefined,
  reasoning: boolean,
) {
  const model = resolveAiConfig().model
  // `reasoning` is OpenRouter's own field, so it is not in the SDK's params
  // type; the cast is at this one call site rather than on the config object.
  const extra = reasoning ? ({ reasoning: { enabled: true } } as Record<string, unknown>) : {}
  // Two call sites rather than one params object: `stream: true` has to be a
  // literal for the SDK to pick its streaming overload.
  return temperature === undefined
    ? getClient().chat.completions.create({ model, messages, stream: true, ...extra }, { signal })
    : getClient().chat.completions.create({ model, messages, stream: true, temperature, ...extra }, { signal })
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
  if (!ai.model) return fail('No model is set — type the name the endpoint expects, e.g. gpt-4o-mini.')
  if (!ai.apiKey && !isKeylessProvider(ai.provider)) {
    return fail('No API key is set — paste one, or switch the provider to a local runtime that does not need one.')
  }

  const began = Date.now()
  try {
    const completion = await getClient().chat.completions.create(
      { model: ai.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 },
      { timeout: TEST_TIMEOUT_MS },
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
    return fail(`${baseUrl} rejected the API key. Paste the key again, or check it has not been revoked.`)
  }
  if (status === 429) {
    return fail('The endpoint answered but is rate-limiting or out of quota — the key and address are right, the account is not ready.')
  }
  if (status !== null && status >= 500) {
    return fail(`${baseUrl} answered with a server error (${status}). The address and key look right; the endpoint itself is unwell.`)
  }
  if (status === 400 || status === 404 || status === 422) {
    return await afterRejection(model, baseUrl, status, detail)
  }
  if (status !== null) {
    return fail(`${baseUrl} refused the request (${status}). ${detail}`.trim())
  }
  // No status at all: nothing answered, so this is the address or the network.
  const code = causeCode(err)
  if (isTimeout(err)) {
    return fail(`${baseUrl} did not answer within ${TEST_TIMEOUT_MS / 1000} seconds. Is it running, and reachable from the Colloq container?`)
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
    const page = await getClient().models.list({ timeout: TEST_TIMEOUT_MS })
    models = page.data.map((entry) => entry.id)
  } catch (listErr) {
    const listStatus = statusOf(listErr)
    if (listStatus === 401 || listStatus === 403) {
      return fail(`${baseUrl} rejected the API key. Paste the key again, or check it has not been revoked.`)
    }
    if (status === 404) {
      return fail(`${baseUrl} answered 404 for both a completion and /models — the base URL is probably wrong (most endpoints need the /v1 on the end).`)
    }
    return fail(`${baseUrl} refused the request: ${detail || `HTTP ${status}`}`)
  }

  const ms = Date.now() - began
  if (models.length > 0 && !models.includes(model)) {
    const offered = models.slice(0, 6).join(', ')
    return {
      ok: false,
      ms: null,
      message: `${baseUrl} has no model called "${model}". It offers: ${offered}${models.length > 6 ? ', …' : ''}.`,
      model: null,
    }
  }
  // The endpoint answers and knows the model, but would not take our test call —
  // some gateways refuse max_tokens: 1, which says nothing about real questions.
  return {
    ok: true,
    ms,
    message: `${baseUrl} answered and knows "${model}", but rejected the one-token test call${detail ? ` (${detail})` : ''}. Real questions will probably work — ask one to be sure.`,
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

/** Raw SDK errors carry request internals; hand back something readable instead. */
function friendly(err: unknown): Error {
  const status = (err as { status?: number } | null)?.status
  const ai = resolveAiConfig()
  console.warn('[ai] request failed', status ? `status ${status}` : 'no response')

  if (status === 401 || status === 403) {
    return new Error('The AI endpoint rejected the API key — check it in the admin panel, or OPENAI_API_KEY.')
  }
  if (status === 404) {
    return new Error(`The AI endpoint has no model "${ai.model}" — check the model name.`)
  }
  if (status === 400) {
    return new Error(`The AI endpoint rejected the request for model "${ai.model}".`)
  }
  if (status === 429) {
    return new Error('The AI endpoint is rate-limiting us — try again in a moment.')
  }
  if (status !== undefined && status >= 500) {
    return new Error('The AI endpoint returned a server error.')
  }
  return new Error(`Could not reach the AI endpoint at ${ai.baseUrl}.`)
}
