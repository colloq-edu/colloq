import { tr } from '@shared/i18n'
/**
 * An oracle hint for one student — about their failed attempt in the council.
 *
 * A neighbour of the oracle about solutions (ai/council.ts), and deliberately
 * not that oracle. That one looks FROM ABOVE: five hundred sheets, six groups,
 * three paragraphs for the teacher. This one looks at one sheet, knows the
 * traceback and answers one person — and all they have in common is the task
 * in the frame header and the provider at the other end.
 *
 * Three things are held here on purpose.
 *
 * The model does not see the name. It gets the task, the teacher's stub, the
 * text of the attempt and the traceback — no name, no avatar, no groupmates.
 * The hint is personal, and what should be personal in it is the answer, not
 * what went off to someone else's provider.
 *
 * It nudges rather than solves. The person wrote this code themselves and
 * pressed "Run" themselves; a finished solution arriving as a letter cancels
 * both. That is why the system frame sets a ceiling: name the cause and the
 * line, give at most one concrete piece of advice, and do NOT write corrected
 * code. The rule is held by words, not by parsing the answer: a model that
 * decides to disobey will write something anyway, and better that it be a
 * wordy hint than a red error in the middle of a class.
 *
 * The texts are private. Neither the question nor the answer goes into the
 * room's shared thread (routes/ai.ts · `/ai/ask` writes to it, and the whole
 * class reads it): the answer comes back as a letter inside the attempt
 * itself, where its author and the teacher see it — the same two people who
 * see its text.
 */
import type { CellOutput } from '@shared/notebook'
import type { CouncilRun } from '@shared/protocol'
import { getOracleSettings } from '../admin/settings.js'
import { noteTokens } from '../admin/usage.js'
import { streamChat, type ChatTurn } from './provider.js'
import { COUNCIL_WATCH, watchSilence } from './watch.js'
import { clip as clipTo, flatten } from './text.js'

/** What the hint needs from an attempt: the code, the task around it, how it ended. */
export interface HintInput {
  /** The problem statement: the markdown cell above the task, if there is one. */
  before: string | null
  /** The teacher's stub: the cell's text at the moment the council was opened. */
  stub: string | null
  /** What the person wrote. */
  attempt: string
  /** How the run ended. */
  run: CouncilRun | null
}

/*
 * How much code and traceback goes to the model.
 *
 * Fifteen hundred characters per attempt is forty lines, almost always a whole
 * sheet. The traceback is shorter: what matters in it is the last frame and the
 * line with the exception, and the middle is the library's stack, from which
 * nothing follows.
 */
const MAX_ATTEMPT = 1_500
const MAX_TASK = 2_000
const MAX_TRACEBACK = 1_200

function clip(text: string, limit: number): string {
  return clipTo(text, limit, (dropped) => `\n… пропущено ${dropped} знаков …\n`)
}

/**
 * The traceback as one block of text — the one the person sees under their cell.
 *
 * Jupyter returns it as a list of lines with ANSI colouring; the model does not
 * need the colours, but it does need the last frame, so the BEGINNING is cut
 * (`clip` keeps the head and the tail, and here the tail matters more). Empty
 * means the run failed without a traceback (an interrupt, the kernel dying),
 * and then only the exception name remains.
 */
export function tracebackOf(outputs: readonly CellOutput[]): string {
  const error = outputs.find((output): output is Extract<CellOutput, { kind: 'error' }> =>
    output.kind === 'error',
  )
  if (!error) return ''
  const body = error.traceback.length > 0 ? error.traceback.join('\n') : error.evalue
  const head = `${error.ename}${error.evalue ? `: ${error.evalue}` : ''}`
  const text = stripAnsi(body).trim()
  return text.includes(error.ename) ? text : `${head}\n${text}`
}

/** Terminal colouring is noise in the model's frame and extra tokens on every line. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[A-Za-z]/g, '')
}

/** Did the run fail — the only state in which there is anything to ask a hint for. */
export function runFailed(run: CouncilRun | null | undefined): boolean {
  if (!run || run.state !== 'error') return false
  return true
}

const SYSTEM = [
  'Ты помогаешь студенту на семинаре разобраться в СВОЕЙ ошибке.',
  'Тебе дано задание, заготовка преподавателя, код студента и трейсбек.',
  '',
  'Правила ответа, без исключений:',
  '1. Назови ПРИЧИНУ ошибки и строку, в которой она возникла.',
  '2. Дай не больше ОДНОГО конкретного совета, что попробовать.',
  '3. НЕ пиши исправленный код, не приводи готового решения и не дописывай',
  '   за студента — он должен исправить сам.',
  '4. Три-четыре предложения, на «вы», без вступлений и без списков.',
].join('\n')

/** The frame for the model. A function of its own: the test reads it, not the network. */
export function hintPrompt(
  input: HintInput,
  budget: number = getOracleSettings().contextChars,
): ChatTurn[] {
  const system = SYSTEM + '\n' + tr('server.ai.answerLanguage')
  const parts: string[] = []
  if (input.before) parts.push('УСЛОВИЕ:', clip(flatten(input.before), MAX_TASK), '')
  if (input.stub && input.stub.trim()) {
    parts.push('ЗАГОТОВКА ПРЕПОДАВАТЕЛЯ:', '```python', clip(input.stub, MAX_TASK), '```', '')
  }
  parts.push('КОД СТУДЕНТА:', '```python', clip(input.attempt, MAX_ATTEMPT), '```', '')
  const traceback = input.run ? tracebackOf(input.run.outputs) : ''
  if (traceback) parts.push('ТРЕЙСБЕК:', '```', clip(traceback, MAX_TRACEBACK), '```')
  const user = parts.join('\n')
  /*
   * The budget cuts the TASK, not the traceback: without the statement the hint
   * comes out generic, and without the traceback there is nothing to give it
   * about at all. A rare case — the whole frame here fits in six thousand
   * characters — but the instance budget may be set lower, and then it should
   * not be the order of lines in this function that chooses.
   */
  const over = system.length + user.length - budget
  if (over > 0 && parts[0] === 'УСЛОВИЕ:') {
    parts.splice(0, 3)
    return [
      { role: 'system', content: system },
      { role: 'user', content: parts.join('\n') },
    ]
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export interface AskHint extends HintInput {
  /** The usage row created at intake: the tokens will be added to it. */
  usageId?: number
  signal?: AbortSignal
}

/**
 * Ask and return the hint text. Throws what the provider throws: in words that
 * can be shown to a person.
 *
 * Under the same watchdog as the council oracle (ai/watch.ts). A hint is asked
 * for by one student about one failed attempt — nobody is going to wait half
 * an hour for it, and a hanging "the oracle is thinking" in the card is no
 * better than a hanging summary. The deadlines are the same: a minute and a
 * half until the first frame, forty-five seconds between frames, three minutes
 * for everything.
 */
export async function askCouncilHint(input: AskHint): Promise<string> {
  /*
   * Our own controller on top of someone else's signal: the watchdog needs
   * something to abort, and a cancellation from outside (the person left, the
   * room was torn down) must reach here as it was. The listener is removed in
   * `finally` — otherwise the room's long-lived signal would accumulate a
   * listener for every hint.
   */
  const controller = new AbortController()
  const relay = () => controller.abort()
  if (input.signal?.aborted) return ''
  input.signal?.addEventListener('abort', relay, { once: true })
  const guard = watchSilence(controller, COUNCIL_WATCH)
  try {
    const text = await streamChat(
      hintPrompt(input),
      () => guard.heard(),
      controller.signal,
      (tokens) => {
        if (input.usageId !== undefined) noteTokens(input.usageId, tokens)
      },
    )
    // The watchdog cut it off, not the person — that is a refusal, and it has
    // to be named in words: an empty hint looks like "the model has nothing to
    // say", while in fact it is silent.
    if (guard.why !== null) {
      throw new Error(
        guard.spoke
          ? tr('server.theModelStoppedSendingItsResponseTry.3aa75a')
          : tr('server.theModelDidNotRespondWithinThe.be1746'),
      )
    }
    return text.trim()
  } finally {
    guard.stop()
    input.signal?.removeEventListener('abort', relay)
  }
}
