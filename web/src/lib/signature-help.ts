/**
 * Справка ядра, разобранная на части: сигнатура отдельно, документация отдельно.
 *
 * Ядро отвечает на `inspect_request` одним куском текста, размеченным
 * заголовками IPython (`Signature:`, `Docstring:`, `Type:`, `File:` …). Пока
 * подсказка показывала первые шесть строк этого куска, она честно работала
 * ровно для `df.head(n=5)` и разваливалась на всём остальном: у
 * `sns.lmplot(...)` одна только сигнатура занимает двадцать пять строк, и
 * человек видел обрубок
 *
 *     Signature:
 *     sns.lmplot(
 *         data,
 *         *,
 *         x=None,
 *
 * — то есть ровно те параметры, которые он и так набрал, и ни одного из тех,
 * ради которых наводился.
 *
 * Разбор живёт отдельным файлом и ничего не знает ни про CodeMirror, ни про
 * DOM: это чистая функция над строкой, и проверяется она настоящими ответами
 * ядра (tests/signature-help.test.mts), а не тем, как выглядит окно.
 *
 * Тем же разбором читается ответ СТАТИЧЕСКОГО пути (server/src/kernel/
 * inspect-static.ts): jedi отвечает не тем же самым текстом, но той же
 * разметкой — заголовками IPython, — и это условие всей затеи. Два разбора на
 * две дороги разошлись бы молча: один и тот же `sns.lmplot` выглядел бы в
 * подсказке по-разному в зависимости от того, запускали в комнате ячейку с
 * импортом или ещё нет.
 */

/**
 * Заголовки, которыми IPython размечает ответ (IPython/core/oinspect.py ·
 * `info_fields`), — и только они.
 *
 * Закрытый список, а не «слово с двоеточием в начале строки», потому что
 * внутри самой документации таких строк сколько угодно: в примерах pandas
 * печатаются таблицы, в numpy — разделы, и любой `Warning:` посреди docstring
 * разрезал бы её пополам. Незнакомый заголовок здесь — не беда: его строка
 * просто останется частью того раздела, в котором стоит.
 */
const SECTIONS = [
  'Signature',
  'Init signature',
  'Call signature',
  'Definition',
  'Docstring',
  'Init docstring',
  'Class docstring',
  'Call docstring',
  'Type',
  'Base Class',
  'String form',
  'Namespace',
  'Length',
  'File',
  'Source',
  'Subclasses',
  'Repr',
] as const

type Section = (typeof SECTIONS)[number]

const HEADER = new RegExp(`^(${SECTIONS.join('|')}):(.*)$`)

/**
 * Разделы, внутри которых лежит ЧУЖОЙ текст, — то есть документация.
 *
 * Отличать их приходится потому, что внутри документации бывает что угодно, в
 * том числе строка `File:      example` из примера к `open()`. См. `PROSE`
 * ниже: именно эти разделы и защищаются от заголовков посреди себя.
 */
const DOCS: readonly Section[] = [
  'Docstring',
  'Init docstring',
  'Class docstring',
  'Call docstring',
  'Source',
]

/**
 * Приписки: одна строка, «что это и откуда».
 *
 * IPython ставит их либо ДО документации (у модулей и значений), либо
 * слипшимся хвостом в самом конце (у функций и методов). Из этого и растёт
 * правило ниже: посреди документации такая строка — почти наверняка её часть,
 * а не конец раздела.
 */
const FACTS: readonly Section[] = [
  'Type',
  'Base Class',
  'String form',
  'Namespace',
  'Length',
  'File',
  'Subclasses',
  'Repr',
]

const FACT_LINE = new RegExp(`^(${FACTS.join('|')}):`)

/**
 * С какой строки начинается слипшийся хвост приписок.
 *
 * Считается с конца: пустые строки, потом подряд идущие `Type:`/`File:`/…
 * Всё, что выше, — текст, даже если строка выглядит заголовком. Без этого
 * счёта документация `open()` обрывалась на строке `File:      example` из
 * собственного примера, и половина справки просто исчезала — молча, как всегда
 * в таких случаях.
 */
function tailStart(lines: readonly string[]): number {
  let at = lines.length
  while (at > 0 && lines[at - 1].trim() === '') at--
  while (at > 0 && FACT_LINE.test(lines[at - 1])) at--
  return at
}

/**
 * Чем IPython отвечает, когда сказать нечего.
 *
 * Строка приезжает на месте документации у модулей и у половины значений, и
 * показывать её как документацию значило бы занимать окно словами «no
 * docstring» вместо того, чтобы окна не открывать вовсе.
 */
const NOTHING = '<no docstring>'

export interface SignatureHelp {
  /** Сигнатура ЦЕЛИКОМ, как её написало ядро; `''` — её нет (значение, модуль). */
  signature: string
  /** Документация целиком; `''` — её нет. */
  doc: string
  /** Что это: `function`, `method`, `module`, `DataFrame`. Мелкой пометкой. */
  type: string
  /**
   * Как значение выглядит — `String form` ядра.
   *
   * Только у НЕ вызываемого: у функции это `<function lmplot at 0x7f…>`, то
   * есть адрес в памяти чужого процесса — шум, занимающий строку. А у `x = 42`
   * или у собранного `df` это ровно тот ответ, за которым наводились.
   */
  form: string
  /** `len()` значения, если ядро его сказало. */
  length: string
  /**
   * Разобрать не удалось — показать как есть.
   *
   * Не все ядра — IPython: в комнате может стоять ядро R или Julia, и разметка
   * у него своя. Показать чужой текст целиком лучше, чем не показать ничего:
   * человек всё равно прочтёт его глазами, а мы не обязаны понимать каждое
   * ядро на свете.
   */
  raw: string
}

const EMPTY: SignatureHelp = { signature: '', doc: '', type: '', form: '', length: '', raw: '' }

/** Склеить строки раздела: хвост строки заголовка плюс всё до следующего. */
function joinSection(lines: string[]): string {
  const rows = [...lines]
  /*
   * Хвост строки заголовка — особый: у однострочных значений он выровнен
   * пробелами (`Type:      method`), и эти пробелы ничего не значат. У
   * многострочных он пуст или пробелен вовсе. Внутренние строки не трогаем:
   * там отступы кода и примеров, и подровнять их значило бы сломать `>>>`.
   */
  if (rows.length > 0) rows[0] = rows[0].trim()
  while (rows.length > 0 && rows[0].trim() === '') rows.shift()
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  // Хвостовые пробелы IPython расставляет щедро; в окне они не видны, но
  // выделение мышью захватывает их вместе с текстом.
  const text = rows.join('\n').replace(/[ \t]+$/gm, '')
  return text === NOTHING ? '' : text
}

/**
 * Разобрать ответ ядра на части.
 *
 * Ничего не выбрасывает и ничего не режет: обрезать нечего — окно прокручивается.
 */
export function parseSignatureHelp(text: string): SignatureHelp {
  if (typeof text !== 'string' || text.trim() === '') return { ...EMPTY }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const tail = tailStart(lines)
  const found = new Map<Section, string[]>()
  /** Строки до первого заголовка — у ядра не-IPython это весь ответ. */
  const preamble: string[] = []
  let current: string[] = preamble
  /** Читаем ли мы сейчас чужой текст, в котором заголовков не бывает. */
  let prose = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const header = HEADER.exec(line)
    const name = header ? (header[1] as Section) : null
    // Приписка посреди документации — часть документации; см. `tailStart`.
    const real = name !== null && !(prose && i < tail && FACTS.includes(name))
    if (real && name !== null) {
      /*
       * Первый раздел с таким именем побеждает. Повтор возможен только в
       * документации, и дописывать к разделу его второе вхождение значило бы
       * склеить справку с куском docstring.
       */
      if (found.has(name)) {
        current.push(line)
        continue
      }
      current = [header![2]]
      found.set(name, current)
      prose = DOCS.includes(name)
      continue
    }
    current.push(line)
  }

  if (found.size === 0) {
    return { ...EMPTY, raw: joinSection(preamble) }
  }

  const value = (name: Section) => {
    const rows = found.get(name)
    return rows ? joinSection(rows) : ''
  }

  /*
   * Порядок предпочтения — от самого точного к самому общему. У класса
   * сигнатуры нет вовсе, зато есть `Init signature`, и показать надо её: люди
   * наводятся на `pd.DataFrame`, чтобы узнать, что ему передают.
   */
  const signature =
    value('Signature') || value('Init signature') || value('Call signature') || value('Definition')
  /*
   * Документация класса — это ДВЕ документации, и обе по делу: своя у класса,
   * своя у `__init__`. Склеиваются пустой строкой, как их разделил бы автор.
   */
  const doc = [value('Docstring'), value('Class docstring'), value('Init docstring'), value('Call docstring')]
    .filter((part) => part !== '')
    .join('\n\n')
  const lead = joinSection(preamble)
  return {
    signature,
    doc: lead === '' ? doc : doc === '' ? lead : `${lead}\n\n${doc}`,
    type: value('Type'),
    // См. `form`: у вызываемого это адрес объекта в чужом процессе.
    form: signature === '' ? value('String form') : '',
    length: value('Length'),
    raw: '',
  }
}

/** Есть ли что показывать: пустую подсказку открывать незачем. */
export function helpIsEmpty(help: SignatureHelp): boolean {
  return (
    help.signature === '' &&
    help.doc === '' &&
    help.type === '' &&
    help.form === '' &&
    help.length === '' &&
    help.raw === ''
  )
}

/* ------------------------------------------------------------------ память */

/**
 * Сколько ответ ядра считается свежим.
 *
 * Минута — это «пока человек читает эту ячейку». Дольше держать нельзя: между
 * двумя наведениями кто-нибудь в комнате переопределит `df`, и подсказка
 * начнёт рассказывать про позапрошлый объект — врать увереннее, чем молчать.
 * Меньше — и повторное наведение на то же имя снова ходило бы в ядро, а ради
 * этого кэш и заведён: справка обязана появляться мгновенно на второй раз.
 */
export const HELP_TTL_MS = 60_000

/** Потолок памяти: тетрадь на восемьдесят ячеек не должна копить их все. */
const HELP_MAX = 200

const remembered = new Map<string, { at: number; text: string }>()

/** Ключ — имя В ПРЕДЕЛАХ ячейки: один и тот же `df` в разных ячейках разный. */
export function helpKey(cellId: string | null, name: string): string {
  return `${cellId ?? ''} ${name}`
}

/** Что ядро уже говорило об этом имени, если говорило недавно. */
export function rememberedHelp(key: string, now = Date.now()): string | null {
  const row = remembered.get(key)
  if (!row) return null
  if (now - row.at > HELP_TTL_MS) {
    remembered.delete(key)
    return null
  }
  return row.text
}

/**
 * Запомнить ответ ядра — и только НАЙДЕННЫЙ.
 *
 * Отказы не помнятся намеренно: «ядро запускается» и «ядро занято» — это
 * состояния на секунду, и запомнить их на минуту значило бы показывать вчерашнюю
 * причину тогда, когда ответ уже есть. Второе наведение обязано спросить заново.
 */
export function rememberHelp(key: string, text: string, now = Date.now()): void {
  if (remembered.size >= HELP_MAX) {
    const oldest = remembered.keys().next()
    if (!oldest.done) remembered.delete(oldest.value)
  }
  remembered.set(key, { at: now, text })
}

/**
 * Забыть всё: в ядре только что что-то посчитали.
 *
 * Запуск ячейки — единственное событие, после которого прошлый ответ может
 * оказаться неправдой: `df` стал другим, функция переопределена, импорт
 * наконец выполнен. Чистим целиком, а не по одному имени: запущенная ячейка
 * меняет пространство имён ЯДРА, то есть всё, что лежит в этой памяти.
 */
export function forgetHelp(): void {
  remembered.clear()
}
