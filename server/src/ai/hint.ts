import { tr } from '@shared/i18n'
/**
 * Подсказка оракула одному студенту — по его упавшей попытке в консилиуме.
 *
 * Сосед оракула о решениях (ai/council.ts), и нарочно не он. Тот смотрит СВЕРХУ:
 * пятьсот листов, шесть групп, три абзаца преподавателю. Этот смотрит в один
 * лист, знает трейсбек и отвечает одному человеку — и всё, что их роднит,
 * это задание в шапке кадра и провайдер на том конце.
 *
 * Три вещи держатся здесь нарочно.
 *
 * Модель не видит имени. Ей едут задание, заготовка преподавателя, текст
 * попытки и трейсбек — ни имени, ни аватара, ни соседей по группе. Подсказка
 * личная, и личным в ней должен быть ответ, а не то, что ушло чужому провайдеру.
 *
 * Она подталкивает, а не решает. Человек сам написал этот код и сам нажал
 * «Запустить»; готовое решение, приехавшее письмом, отменяет и то, и другое.
 * Поэтому в системном кадре стоит потолок: назвать причину и строку, дать не
 * больше одного конкретного совета и НЕ писать исправленный код. Правило
 * держится словами, а не разбором ответа: модель, решившая ослушаться, всё
 * равно напишет что-нибудь, и лучше это будет многословная подсказка, чем
 * красная ошибка посреди занятия.
 *
 * Тексты частные. Ни вопрос, ни ответ не ложатся в общий тред комнаты
 * (routes/ai.ts · `/ai/ask` пишет в него, и это читает весь класс): ответ
 * возвращается письмом внутрь самой попытки, где его видят автор и
 * преподаватель — те же двое, что видят её текст.
 */
import type { CellOutput } from '@shared/notebook'
import type { CouncilRun } from '@shared/protocol'
import { getOracleSettings } from '../admin/settings.js'
import { noteTokens } from '../admin/usage.js'
import { streamChat, type ChatTurn } from './provider.js'
import { clip as clipTo, flatten } from './text.js'

/** Что подсказке нужно от попытки: код, задание вокруг и то, чем всё кончилось. */
export interface HintInput {
  /** Условие: маркдаун-ячейка над заданием, если она есть. */
  before: string | null
  /** Заготовка преподавателя — текст ячейки на момент открытия консилиума. */
  stub: string | null
  /** Что человек написал. */
  attempt: string
  /** Чем кончился запуск. */
  run: CouncilRun | null
}

/*
 * Сколько кода и трейсбека едет модели.
 *
 * Полторы тысячи знаков на попытку — сорок строк, целый лист почти всегда.
 * Трейсбек короче: в нём важны последний кадр и строка с исключением, а
 * середина — это стек библиотеки, из которого не следует ничего.
 */
const MAX_ATTEMPT = 1_500
const MAX_TASK = 2_000
const MAX_TRACEBACK = 1_200

function clip(text: string, limit: number): string {
  return clipTo(text, limit, (dropped) => `\n… пропущено ${dropped} знаков …\n`)
}

/**
 * Трейсбек одной строкой блока — тот, что видит человек под своей ячейкой.
 *
 * Jupyter отдаёт его списком строк с ANSI-раскраской; цвета модели не нужны, а
 * вот последний кадр — нужен, поэтому режется НАЧАЛО (`clip` оставляет голову и
 * хвост, и хвост здесь важнее). Пусто — значит запуск упал без трейсбека
 * (прерывание, смерть ядра), и тогда остаётся одно имя исключения.
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

/** Раскраска терминала — шум в кадре модели и лишние токены в каждой строке. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*[A-Za-z]/g, '')
}

/** Упал ли запуск — единственное состояние, в котором подсказку есть о чём просить. */
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

/** Кадр для модели. Отдельной функцией — её и читает тест, а не поход в сеть. */
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
   * Бюджет режет ЗАДАНИЕ, а не трейсбек: без условия подсказка выйдет общей, а
   * без трейсбека её не о чем давать вовсе. Случай редкий — весь кадр здесь
   * укладывается в шесть тысяч знаков, — но бюджет инстанса может стоять и
   * ниже, и тогда выбирать должен не порядок строк в этой функции.
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
  /** Строка расхода, заведённая при приёме: токены лягут на неё. */
  usageId?: number
  signal?: AbortSignal
}

/**
 * Спросить и вернуть текст подсказки. Бросает то же, что и провайдер: словами,
 * которые можно показать человеку.
 */
export async function askCouncilHint(input: AskHint): Promise<string> {
  const text = await streamChat(
    hintPrompt(input),
    () => {},
    input.signal,
    (tokens) => {
      if (input.usageId !== undefined) noteTokens(input.usageId, tokens)
    },
  )
  return text.trim()
}
