/**
 * Единственное место, где CLI что-то печатает.
 *
 * Словарь закрыт: пять символов, четыре цвета, таблицы руками. Зелёного нет —
 * его нет и в Makefile. Цвет гаснет целиком при NO_COLOR, --no-color и когда
 * вывод не в терминал: тогда в потоке не остаётся ни одного байта escape, и
 * это стережёт тест.
 */

/** Символы. Других не заводить: ● работает · ○ нет · ✓ пройдено · ✗ отказ · → дальше. */
export const SYMBOL = { on: '●', off: '○', ok: '✓', bad: '✗', next: '→' } as const

// Коды те же, что в шапке Makefile.
const BOLD = '\u001b[1m'
const DIM = '\u001b[2m'
const CYAN = '\u001b[36m'
const RED = '\u001b[31m'
const OFF = '\u001b[0m'

/**
 * Не выполнено предусловие: нет .env, нет docker, нет терминала для вопроса — код 3.
 *
 * Три части те же, что у ui.refuse: что случилось, чем вызвано, что делать.
 * why необязательна — второй строки просто не будет.
 */
export class PreconditionError extends Error {
  readonly code = 3
  readonly fix: string
  readonly why: string
  constructor(message: string, fix = '', why = '') {
    super(message)
    this.name = 'PreconditionError'
    this.fix = fix
    this.why = why
  }
}

/** Употребление: нет команды, нет обязательного аргумента, конфликт флагов — код 2. */
export class UsageError extends Error {
  readonly code = 2
  readonly fix: string
  readonly why: string
  constructor(message: string, fix = '', why = '') {
    super(message)
    this.name = 'UsageError'
    this.fix = fix
    this.why = why
  }
}

export type Ui = {
  /** Включён ли цвет. */
  readonly color: boolean
  /** Режим --json: обычный вывод погашен целиком. */
  readonly jsonMode: boolean
  bold(text: string): string
  dim(text: string): string
  cyan(text: string): string
  red(text: string): string
  /** Строка как есть, в stdout. */
  line(text?: string): void
  /** Заголовок раздела — одна строка BOLD. */
  header(text: string): void
  /** Ключ-значение: два пробела, ключ padEnd(12), значение, за ним « · » и DIM-пояснение. */
  kv(key: string, value: string, hint?: string): void
  /** Подсказка под строкой: шесть пробелов, DIM, начинается с «→ ». */
  hint(text: string): void
  /** Таблица руками: padEnd по измеренной ширине, отступ два пробела, рамок нет. */
  table(rows: string[][]): void
  /** Отказ — ровно три строки в stderr: что, почему, что делать. */
  refuse(what: string, why: string, fix: string): void
  /** Вопрос с умолчанием «нет». Нет терминала — PreconditionError (код 3). */
  confirm(question: string): Promise<boolean>
  /** Печатает JSON и гасит весь остальной вывод. */
  json(value: unknown): void
}

export type UiOptions = {
  color?: boolean
  json?: boolean
  out?: (text: string) => void
  err?: (text: string) => void
  /** Терминал ли перед нами: от этого зависит, можно ли спрашивать. */
  tty?: boolean
  /** Подставной источник ответов — для тестов. */
  ask?: (question: string) => Promise<string>
}

/** Длина строки без escape-последовательностей: по ней считается ширина колонки. */
export function visibleLength(text: string): number {
  return stripAnsi(text).length
}

/** Снять escape-последовательности. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

/** Цвет разрешён? NO_COLOR при любом значении и не-терминал гасят его целиком. */
export function colorAllowed(env: NodeJS.ProcessEnv, isTty: boolean): boolean {
  if ('NO_COLOR' in env) return false
  return isTty
}

/**
 * Запись в поток, который могли закрыть с той стороны.
 *
 * `colloq doctor | head` закрывает трубу на десятой строке, и следующий write
 * бросает EPIPE. Для нас это не ошибка: читателю хватило. Молча замолкаем —
 * ровно так же ведут себя обычные утилиты.
 */
function writer(stream: NodeJS.WriteStream): (text: string) => void {
  let broken = false
  stream.on('error', () => void (broken = true))
  return (text: string) => {
    if (broken) return
    try {
      stream.write(text + '\n')
    } catch {
      broken = true
    }
  }
}

export function createUi(opts: UiOptions = {}): Ui {
  const color = opts.color ?? false
  const out = opts.out ?? writer(process.stdout)
  const err = opts.err ?? writer(process.stderr)
  const tty = opts.tty ?? false
  let jsonMode = opts.json ?? false
  // Однажды напечатанный JSON — весь вывод команды: второй раз не печатаем.
  let jsonDone = false

  const paint = (code: string, text: string): string => (color ? code + text + OFF : text)

  const ui: Ui = {
    get color() {
      return color
    },
    get jsonMode() {
      return jsonMode
    },
    bold: (text) => paint(BOLD, text),
    dim: (text) => paint(DIM, text),
    cyan: (text) => paint(CYAN, text),
    red: (text) => paint(RED, text),
    line(text = '') {
      if (jsonMode) return
      out(text)
    },
    header(text) {
      if (jsonMode) return
      out(ui.bold(text))
    },
    kv(key, value, hint) {
      if (jsonMode) return
      // Пояснение отделяется точкой, а не одним цветом: без цвета (труба,
      // NO_COLOR, журнал) значение и пояснение слипались в одну фразу.
      const tail = hint ? ' · ' + ui.dim(hint) : ''
      out('  ' + key.padEnd(12) + value + tail)
    },
    hint(text) {
      if (jsonMode) return
      out('      ' + ui.dim(SYMBOL.next + ' ' + text))
    },
    table(rows) {
      if (jsonMode) return
      if (rows.length === 0) return
      const indent = '  '
      const gap = '  '
      const columns = Math.max(...rows.map((row) => row.length))
      const widths: number[] = []
      for (let i = 0; i < columns; i++) {
        widths[i] = Math.max(...rows.map((row) => visibleLength(row[i] ?? '')))
      }
      for (const row of rows) {
        const cells: string[] = []
        for (let i = 0; i < columns; i++) {
          const cell = row[i] ?? ''
          const pad = ' '.repeat(Math.max(0, (widths[i] ?? 0) - visibleLength(cell)))
          cells.push(cell + pad)
        }
        // Хвостовых пробелов в выводе нет: правый край строки обрезается.
        out((indent + cells.join(gap)).replace(/[ ]+$/, ''))
      }
    },
    refuse(what, why, fix) {
      // В режиме --json отказ — тоже JSON, и ни строки вне него, в том числе
      // на stderr.
      if (jsonMode) {
        ui.json({ ok: false, code: 3, error: what + (why ? '. ' + why : ''), hint: fix })
        return
      }
      err(ui.red(SYMBOL.bad + ' ' + what))
      if (why) err(why)
      if (fix) err(ui.dim(SYMBOL.next + ' ' + fix))
    },
    async confirm(question) {
      const ask = opts.ask
      if (!ask && !tty) {
        throw new PreconditionError(
          'no terminal to ask in',
          'repeat with --yes if you agree in advance',
        )
      }
      const line = SYMBOL.next + ' ' + question + ' [y/N] '
      const answer = ask ? await ask(line) : await readLine(line)
      const value = answer.trim().toLowerCase()
      return value === 'y' || value === 'yes'
    },
    json(value) {
      jsonMode = true
      if (jsonDone) return
      jsonDone = true
      out(JSON.stringify(value))
    },
  }
  return ui
}

/**
 * «3 rooms», «1 package»: число перед словом всегда, слово по числу.
 *
 * Форм две, и правило одно на все слова, поэтому списывать его во второй раз
 * ради пакетов незачем. Второе слово даётся только там, где множественное
 * неправильное: countWord(2, 'class', 'classes'), — обычному хватает 's'.
 */
export function countWord(count: number, one: string, many = one + 's'): string {
  return count + ' ' + (count === 1 ? one : many)
}

/** Счёт комнат нужен двоим: вопросу перед опасным действием и строке состояния. */
export function roomsWord(count: number): string {
  return countWord(count, 'room')
}

/**
 * Шапка долгой работы: одна строка BOLD, дальше поток ребёнка без изменений.
 * Под --dry-run строка ровно одна, и она не наша, — поэтому шапки нет.
 */
export function heading(ctx: { dryRun: boolean; ui: Ui }, text: string): void {
  if (!ctx.dryRun) ctx.ui.header(text)
}

/** «нет» на вопрос: DIM «отменено» и код 4. Говорится одинаково во всех группах. */
export function cancelled(ui: Ui): number {
  ui.line(ui.dim('cancelled'))
  return 4
}

/** Одна строка со stdin. Отдельно, чтобы readline создавался только под вопрос. */
async function readLine(question: string): Promise<string> {
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}
