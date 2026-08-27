/**
 * The oracle, assembled: notebook context + the room's thread + one
 * rewritten prompt, streamed straight into the shared document.
 *
 * The thread used to be a per-person inbox. It is now part of the CRDT, and
 * that is a product decision, not a refactor: a question asked in a private tab
 * helps one student and teaches the teacher nothing. Here every question is
 * attributed, every answer arrives on all screens at once, and the model's
 * continuity is room-wide — a follow-up "and why?" resolves against what the
 * room last asked, even if someone else asked it.
 *
 * Two constraints still shape the prompt. The panel is 380px wide and sits next
 * to code someone is mid-thought on, so answers must open with the answer. And
 * a teacher running an exercise needs an oracle that can withhold the
 * solution on request — that is what the `hint` action is for, and why the
 * action lives here rather than in the client's message box.
 */
import * as Y from 'yjs'
import {
  chatAnswer,
  chatReasoning,
  createChatEntry,
  getCells,
  findChatEntry,
  getChat,
  readChatEntry,
  type ChatState,
  type YChatEntry,
} from '@shared/notebook'
import { getOracleSettings } from '../admin/settings.js'
import { noteTokens } from '../admin/usage.js'
import { getSessionDoc } from '../collab/index.js'
import { buildContext } from './context.js'
import { providerModel, providerReady, streamChat, type ChatTurn } from './provider.js'
import type { AiAction } from '@shared/protocol'
// Re-exported because tests reach for it here, where the patch is actually
// lifted out of an answer; the parser itself is shared with the panel.
import { lastCodeBlock, type CellKind } from '@shared/answer'
export { lastCodeBlock }

/** Marks our writes so persistence and peers can tell them from typing. */
const ORIGIN = 'ai'

/**
 * A token is a few characters; a CRDT update is a frame to every browser in the
 * room. Coalescing on the same principle as kernel stdout keeps a long answer
 * to ~16 updates a second instead of hundreds.
 */
const ANSWER_FLUSH_MS = 60

/** Enough for "and why?" to land, short enough that the notebook stays the loudest thing in the window. */
const MAX_HISTORY_ENTRIES = 10
const MAX_HISTORY_CHARS = 1200

const STOPPED = '(stopped)'

/** Key is `${sessionId}:${entryId}`; an entry is in here only while generating. */
const inflight = new Map<string, AbortController>()

export function aiReady(): boolean {
  return providerReady()
}

export function aiModel(): string {
  return providerModel()
}

export interface AskOptions {
  sessionId: string
  participantId: string
  participantName: string
  participantColor: string
  message: string
  action?: AiAction
  cellId?: string | null
  /**
   * Строка расхода, заведённая при приёме вопроса.
   *
   * Вопрос считают сразу, а токены известны только в конце ответа — и до сих
   * пор не были известны никогда. Идентификатор проходит сюда, чтобы последний
   * кадр потока лёг именно на свою строку, а не на «примерно ту».
   */
  usageId?: number
}

/**
 * Publishes the question to the room and returns its entry id immediately; the
 * answer streams in afterwards. Returning before the model has said anything is
 * the point — the question is visible the instant it is asked, and everyone
 * watches the reply fill in rather than waiting on one person's HTTP response.
 */
export function ask(options: AskOptions): string {
  const doc = docOf(options.sessionId)
  const asked = options.message.trim()

  // Read the thread before the new question joins it, or the model is handed
  // the current question twice.
  const history = recentTurns(doc)

  const entry = createChatEntry({
    participantId: options.participantId,
    name: options.participantName,
    color: options.participantColor,
    question: asked || actionLabel(options.action),
    action: options.action ?? null,
    cellId: options.cellId ?? null,
    /*
     * The cell as it stands right now, so a proposal written against it can
     * later say whether it is still about the same text. Twenty people share
     * this notebook and the model takes seconds: the cell can move while the
     * answer is being written, and applying a rewrite of a paragraph that no
     * longer exists would delete somebody's work in the name of a fix.
     */
    patchBase: options.action === 'edit' ? sourceOfCell(doc, options.cellId ?? null) : null,
  })
  // Read after integration, never before: Yjs refuses to answer get() on a
  // Y.Map that has not joined a document yet and hands back undefined, which
  // made every AiAskResponse.entryId silently missing.
  doc.transact(() => getChat(doc).push([entry]), ORIGIN)
  const entryId = entry.get('id') as string

  void generate(options, entryId, history).catch((err: unknown) => {
    // generate() handles its own failures; this only catches a broken document.
    console.error(`[session ${options.sessionId}] AI thread write failed:`, describe(err))
  })

  return entryId
}

/** Stop one generation and settle its bubble with whatever text arrived. */
export function cancel(sessionId: string, entryId: string): void {
  inflight.get(`${sessionId}:${entryId}`)?.abort()
  // Marked here rather than left to the aborted run, so the room sees the stop
  // land at the moment it was pressed.
  const doc = docOf(sessionId)
  const entry = findChatEntry(doc, entryId)
  if (entry && (entry.get('state') as ChatState) === 'streaming') {
    doc.transact(() => entry.set('state', 'done' as ChatState), ORIGIN)
  }
}

/** Wipes the room's transcript. Callers must enforce that this is a host action. */
export function clearThread(sessionId: string): void {
  const prefix = `${sessionId}:`
  for (const [key, controller] of inflight) {
    if (key.startsWith(prefix)) controller.abort()
  }
  const doc = docOf(sessionId)
  const chat = getChat(doc)
  if (chat.length === 0) return
  doc.transact(() => chat.delete(0, chat.length), ORIGIN)
}

/* --------------------------------------------------------------- streaming */

async function generate(
  options: AskOptions,
  entryId: string,
  history: ChatTurn[],
): Promise<void> {
  const { sessionId } = options
  const key = `${sessionId}:${entryId}`
  const controller = new AbortController()
  inflight.set(key, controller)

  /*
   * Two buffers, because two streams. If the host clears the thread mid-answer
   * there is nothing left to write to, and either buffer noticing that is
   * enough to stop the whole generation.
   */
  const stop = () => controller.abort()
  const answer = new StreamBuffer(sessionId, entryId, chatAnswer, stop)
  const thinking = new StreamBuffer(sessionId, entryId, chatReasoning, stop)

  try {
    if (!providerReady()) {
      throw new Error(
        'No model is set up on this Colloq yet. Whoever runs it can add one under Oracle in the teaching panel.',
      )
    }

    const turns: ChatTurn[] = [
      {
        role: 'system',
        content: systemPrompt(
          options.participantName,
          options.action,
          readContext(sessionId, options.cellId ?? null),
        ),
      },
      ...history,
      {
        role: 'user',
        content: userPrompt(
          options.message.trim(),
          options.participantName,
          options.action,
          options.cellId ?? null,
          kindOfCell(docOf(sessionId), options.cellId ?? null),
        ),
      },
    ]

    /*
     * The wait, measured rather than reported: the clock starts when the
     * request goes out and stops at the first word of the answer, which is
     * exactly the silence a person sat through. A trace arriving in between
     * does not stop it — reading the model think is still waiting.
     */
    const began = Date.now()
    let speaking = false

    const text = await streamChat(
      turns,
      (delta, kind) => {
        if (kind === 'reasoning') {
          thinking.push(delta)
          return
        }
        if (!speaking) {
          speaking = true
          recordThought(sessionId, entryId, Date.now() - began)
        }
        answer.push(delta)
      },
      controller.signal,
      (tokens) => {
        if (options.usageId !== undefined) noteTokens(options.usageId, tokens)
      },
    )
    thinking.flush()
    answer.flush()

    if (controller.signal.aborted) {
      settle(sessionId, entryId, 'done', text.trim() ? null : STOPPED)
      return
    }
    // streamChat resolves empty only when the endpoint answered but said
    // nothing, which is a configuration smell rather than a real reply.
    if (!text.trim()) {
      throw new Error(
        `The AI endpoint returned an empty reply for model "${providerModel()}" — check OPENAI_MODEL.`,
      )
    }
    settle(sessionId, entryId, 'done', null)
  } catch (err) {
    thinking.flush()
    answer.flush()
    if (controller.signal.aborted) {
      settle(sessionId, entryId, 'done', null)
      return
    }
    const reason = describe(err) || 'The oracle is unavailable — check the server logs.'
    console.error(`[session ${sessionId}] AI request failed:`, reason)
    // The reason goes into the bubble: the room is looking at this thread, and
    // an empty grey box tells a class nothing about what broke.
    settle(sessionId, entryId, 'error', reason)
  } finally {
    inflight.delete(key)
  }
}

/**
 * Stamps how long the room waited before the first word arrived.
 *
 * Its own transaction rather than a field on the settle at the end, because it
 * is true the moment it happens and the panel stops saying "thinking" on the
 * strength of it — deferring it to the end of the answer would leave the strip
 * counting up under text that had already arrived.
 */
function recordThought(sessionId: string, entryId: string, ms: number): void {
  const doc = docOf(sessionId)
  const entry = findChatEntry(doc, entryId)
  if (!entry) return
  doc.transact(() => entry.set('thoughtMs', ms), ORIGIN)
}

/**
 * Accumulates deltas and appends them to one of the entry's Y.Texts a window at
 * a time. Also the place where a vanished entry is noticed — the host may have
 * cleared the thread while the model was still talking.
 *
 * `pick` rather than a hardcoded field: the answer and the reasoning arrive
 * interleaved on one stream and are written to two texts, and the only
 * difference between the two writers is which text they append to.
 */
class StreamBuffer {
  private pending = ''
  private timer: NodeJS.Timeout | null = null
  private gone = false

  constructor(
    private readonly sessionId: string,
    private readonly entryId: string,
    private readonly pick: (entry: YChatEntry) => Y.Text,
    private readonly onGone: () => void,
  ) {}

  push(text: string): void {
    if (this.gone || !text) return
    this.pending += text
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, ANSWER_FLUSH_MS)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.gone || !this.pending) return
    const text = this.pending
    this.pending = ''

    const doc = docOf(this.sessionId)
    const entry = findChatEntry(doc, this.entryId)
    if (!entry) {
      this.gone = true
      this.onGone()
      return
    }
    doc.transact(() => {
      const into = this.pick(entry)
      into.insert(into.length, text)
    }, ORIGIN)
  }
}

function settle(sessionId: string, entryId: string, state: ChatState, note: string | null): void {
  const doc = docOf(sessionId)
  const entry = findChatEntry(doc, entryId)
  if (!entry) return
  doc.transact(() => {
    if (note) {
      const answer = chatAnswer(entry)
      answer.insert(answer.length, answer.length > 0 ? `\n\n${note}` : note)
    }
    entry.set('state', state)
    /*
     * The proposal is lifted out at the end rather than while the answer
     * streams: a half-written code block is not a patch, and a cell offering to
     * apply one would be offering to break itself. Only an `edit` turn carries
     * one — the other actions may print code too, and code in an explanation is
     * an illustration, not an offer to rewrite anything.
     */
    if (state === 'done' && entry.get('action') === 'edit') {
      // Тем же видом, каким спрашивали: у текстовой ячейки заграждение
      // помечено markdown, и питоновский набор его не примет.
      const kind = kindOfCell(doc, (entry.get('cellId') as string | null) ?? null)
      const code = lastCodeBlock(chatAnswer(entry).toString(), kind)
      if (code) entry.set('patch', code)
    }
  }, ORIGIN)
}

/**
 * Whether the cell being rewritten holds code or prose.
 *
 * `code` when there is no such cell, which is the shape of every other default
 * in this file: a notebook is mostly code, and a request that names a cell
 * nobody can find should behave like the common case rather than refuse.
 */
function kindOfCell(doc: Y.Doc, cellId: string | null): CellKind {
  if (!cellId) return 'code'
  for (const cell of getCells(doc).toArray()) {
    if (cell.get('id') !== cellId) continue
    return cell.get('type') === 'markdown' ? 'markdown' : 'code'
  }
  return 'code'
}

/** What a cell says at this instant, or null when there is no such cell. */
function sourceOfCell(doc: Y.Doc, cellId: string | null): string | null {
  if (!cellId) return null
  const cells = getCells(doc)
  for (const cell of cells.toArray()) {
    if (cell.get('id') !== cellId) continue
    const source = cell.get('source')
    return source instanceof Y.Text ? source.toString() : String(source ?? '')
  }
  return null
}

function docOf(sessionId: string): Y.Doc {
  return getSessionDoc(sessionId).doc
}

/* ------------------------------------------------------------- transcript */

/**
 * The last few exchanges, whoever had them. Questions carry their asker's name
 * so the model can tell a follow-up from a new thread of thought — and so it
 * can say "as Ana asked earlier" without being told who is in the room.
 */
export function recentTurns(doc: Y.Doc): ChatTurn[] {
  const chat = getChat(doc)
  const turns: ChatTurn[] = []
  for (let i = Math.max(0, chat.length - MAX_HISTORY_ENTRIES); i < chat.length; i++) {
    const snapshot = readChatEntry(chat.get(i))
    const question = snapshot.question.trim()
    if (question) {
      turns.push({
        role: 'user',
        content: `${snapshot.name} asked: ${trimTail(question, MAX_HISTORY_CHARS)}`,
      })
    }
    const answer = snapshot.answer.trim()
    /*
     * A failed turn is not a turn the model took.
     *
     * When a request fails, the sentence that explains it — "The AI endpoint
     * rejected the API key", "the model did not answer within 120 seconds" —
     * is written into the entry's answer, because that is where the room reads
     * it. Sent back as `role: assistant` it becomes something the model
     * believes it said, and every reply after a hiccup was conditioned on a
     * line about the server's own plumbing. A cancelled answer was already
     * excluded for the same reason; an errored one was not.
     */
    if (answer && answer !== STOPPED && snapshot.state !== 'error') {
      turns.push({ role: 'assistant', content: trimTail(answer, MAX_HISTORY_CHARS) })
    }
  }
  return turns
}

function readContext(sessionId: string, cellId: string | null): string {
  try {
    return buildContext(sessionId, cellId)
  } catch (err) {
    // A question without the notebook is worth answering; a dead thread is not.
    console.warn(`[session ${sessionId}] could not build AI context:`, describe(err))
    return '(the notebook could not be read for this question — answer from the conversation alone and say the notebook was unavailable)'
  }
}

/* ---------------------------------------------------------------- prompts */

function systemPrompt(
  participantName: string,
  action: AiAction | undefined,
  context: string,
): string {
  const rules = [
    'You are the AI oracle built into Colloq, a live seminar notebook that a class is working in right now.',
    `${participantName} asked this question, and every other person in the seminar can read your reply: answer the room, not a private tab, and name whoever asked when it helps ("${participantName} is running into…").`,
    'Earlier turns in this thread were asked by different people; each question is labelled with its asker.',
    'Lead with the answer in one or two sentences, then the reasoning behind it. Never open with a preamble or a restatement of the question.',
    'When you propose code, give exactly one runnable Python block that drops into this notebook as written — no ellipses, no pseudo-code.',
    'Never invent library APIs. If you are not certain a function, argument or attribute exists, say so and show how to check it.',
    'If the notebook below contains a traceback, explain what actually caused it before offering any fix.',
    'The notebook below was read at the moment of the question; it outranks anything said earlier in this conversation.',
    'Your reply renders in a 380px side panel: short paragraphs, few bullets, no headings, no sign-off.',
  ]
  if (action === 'hint') {
    rules.push(
      'This turn is a hint: the student has to reach the solution themselves, so do not write it for them.',
    )
  }
  // Last, and said to outrank the rest: this is the teacher for this course
  // fencing off a library or a technique, and a rule that loses to our generic
  // guidance is a rule the panel promised and did not keep.
  const houseRules = getOracleSettings().houseRules
  if (houseRules) {
    rules.push(
      `House rules set by the teacher of this seminar, which outrank the guidance above: ${houseRules}`,
    )
  }
  return `${rules.join('\n')}\n\n--- LIVE NOTEBOOK ---\n${context}`
}

function userPrompt(
  asked: string,
  participantName: string,
  action: AiAction | undefined,
  cellId: string | null,
  kind: CellKind,
): string {
  const target = cellId ? 'the selected cell' : 'the most recently run cell'
  const instruction = actionInstruction(action, target, kind)

  if (!instruction) {
    return (
      asked ||
      `${participantName} opened the oracle without typing anything. In one short line, ask what they are stuck on.`
    )
  }
  // A quick action can carry a typed note with it; the note narrows the action.
  return asked ? `${instruction}\n\n${participantName} also wrote: "${asked}"` : instruction
}

function actionInstruction(
  action: AiAction | undefined,
  target: string,
  kind: CellKind,
): string | null {
  switch (action) {
    case 'explain':
      return `Explain ${target}: what it does and why it is written that way, in plain language, assuming the class has not met this pattern before. Do not rewrite the code unless something in it is genuinely wrong.`
    case 'fix':
      return `${capitalize(target)} is failing. Name the actual cause in one sentence — quote the line or value from the traceback that proves it — then give the corrected code as one runnable Python block. Change nothing unrelated to the failure.`
    case 'debug':
      return `${capitalize(target)} runs but misbehaves. Reason through what the code and its output together imply, name the most likely cause, and give the one or two checks that would confirm it (a shape, a dtype, a printed value). Offer a fix only once the cause is clear.`
    case 'improve':
      return `Give a better version of ${target} — clearer, faster or more idiomatic — as one runnable Python block, then name the tradeoff in a single line: what it gains and what it costs. If the cell is already fine, say so instead of churning it.`
    case 'edit':
      /*
       * The one action whose output is applied rather than read. Everything in
       * this instruction serves that: the whole cell, because a fragment cannot
       * replace anything; exactly one block, because two would leave the
       * interface guessing which is the answer; and the reasoning first,
       * because the room is being asked to approve a change and deserves to
       * know what it does before deciding.
       */
      // Одна и та же механика для двух видов ячеек, но просить надо разное:
      // текстовую ячейку нельзя переписать «запускаемым блоком Python», а
      // ровно этого прежняя формулировка и требовала — оттого предложение для
      // текстовой ячейки не рождалось вовсе.
      return kind === 'markdown'
        ? `Rewrite ${target} to do what was asked. It is a TEXT cell: markdown prose that the class reads, not code that runs. Say in one or two sentences what you are changing and why — that is what the room reads before deciding — then give the COMPLETE new text of the cell as exactly one fenced block tagged \`markdown\`. Not a fragment and not a diff: what you write replaces the cell entirely, so anything you leave out is deleted. Keep the author's voice and language. Change nothing that was not asked for. If the cell already says what was asked, say so plainly and give no block at all.`
        : `Rewrite ${target} to do what was asked. Say in one or two sentences what you are changing and why — that is what the room reads before deciding — then give the COMPLETE new source of the cell as exactly one runnable Python block. Not a fragment and not a diff: what you write replaces the cell entirely, so anything you leave out is deleted. Change nothing that was not asked for. If the cell already does what was asked, say so plainly and give no code block at all.`
    case 'hint':
      return `The student is mid-exercise and must NOT be handed the solution. Give one nudge about ${target}: point at the part worth looking at, or ask the question that unblocks them. No corrected version of their code, no full solution, no line-by-line walkthrough — at most a one-line snippet of a general pattern, and only if it is unavoidable. Two or three sentences.`
    default:
      return null
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** What the room sees as the question when a quick action carried no text. */
function actionLabel(action: AiAction | undefined): string {
  switch (action) {
    case 'explain':
      return 'Explain this cell'
    case 'fix':
      return 'Fix this cell'
    case 'debug':
      return 'Why is this wrong?'
    case 'improve':
      return 'Improve this cell'
    case 'edit':
      return 'Rewrite this cell'
    case 'hint':
      return 'Give me a hint'
    default:
      return 'Help me with this'
  }
}

function trimTail(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}\n… (earlier turn trimmed) …`
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message.trim() : String(err)
}
