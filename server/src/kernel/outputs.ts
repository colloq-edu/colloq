import { tr } from '@shared/i18n'
import * as Y from 'yjs'
import { cellOutputs, findCell, type StreamName, type YOutput } from '@shared/notebook'
import { config } from '../config.js'

/**
 * The bridge from kernel messages to the shared document.
 *
 * Everything here exists because the document is shared. A `for i in range(...)`
 * loop emits one stream message per line, and writing each one straight into
 * Yjs would fan a separate update out to every browser in the room — so text is
 * coalesced into one Y.Text append per flush window, and a runaway cell is
 * capped before it bloats a document that everybody has to load.
 */

/** Marks writes as ours so persistence and peers can tell them from typing. */
const ORIGIN = 'kernel'

/** Roughly a novel of text. Past this the browser is the bottleneck, not Python. */
const MAX_CELL_OUTPUT_CHARS = 400 * 1024

/**
 * У картинок свой бюджет, и он больше.
 *
 * Один `plt.imshow` при dpi=200 — это мегабайт-другой base64, то есть больше
 * всего текстового потолка сразу. Считать их из одного кошелька значило
 * отвечать на семинаре по зрению «output stopped after 400 KB — write to a
 * file instead of printing» вместо картинки, ради которой ячейку и запускали,
 * и заодно глушить весь дальнейший print этой ячейки. Цена известна: столько
 * же уедет каждому в комнате, в снимок и в ключевой кадр истории, — поэтому
 * бюджет на ячейку, а не на кадр, и не «сколько дадут».
 */
const MAX_CELL_DATA_CHARS = 6 * 1024 * 1024

/**
 * Комната, которой этот бюджет достаётся целиком.
 *
 * Цена картинки — не её размер, а размер, умноженный на число открытых вкладок:
 * один `imshow` на два мегабайта в комнате из пятисот человек — это гигабайт
 * исходящего и пятьсот независимых заданий deflate, за которыми встают в
 * очередь ВСЕ остальные правки, включая набор текста. На семинаре из тридцати
 * это шестьдесят мегабайт и никого не трогает, поэтому потолок общий не для
 * всех: до этого числа зрителей он прежний.
 */
const FULL_DATA_BUDGET_VIEWERS = 40
/**
 * Ниже не опускаемся ни при каком зале: обычная картинка matplotlib (`figsize`
 * по умолчанию, dpi 100) — это сотня-другая килобайт, и лекция, где её нельзя
 * показать вовсе, не лучше лекции, которая тормозит.
 */
const MIN_CELL_DATA_CHARS = 768 * 1024

/**
 * Сколько картинок ячейке позволено показать — с оглядкой на то, скольким это
 * поедет. Чистая функция: считать её нечем, кроме числа зрителей, и проверять
 * надо именно правило.
 */
export function dataBudgetFor(viewers: number): number {
  if (!Number.isFinite(viewers) || viewers <= FULL_DATA_BUDGET_VIEWERS) return MAX_CELL_DATA_CHARS
  const scaled = Math.round((MAX_CELL_DATA_CHARS * FULL_DATA_BUDGET_VIEWERS) / viewers)
  return Math.max(MIN_CELL_DATA_CHARS, scaled)
}

/** RecursionError tracebacks run to thousands of identical frames. */
const MAX_TRACEBACK_LINES = 80
/**
 * Длина одной строки ошибки: и `evalue`, и каждого кадра трейсбека.
 *
 * Ошибка идёт мимо потолка ячейки, потому что она и есть причина запуска, — но
 * это не значит «сколько угодно». `assert len(rows) == 0, rows` на списке из
 * миллиона элементов кладёт мегабайты в `evalue` и в последнюю строку
 * трейсбека, а оттуда — во все тридцать браузеров, в снимок и в каждый
 * ключевой кадр истории. Восемьдесят кадров по четыре килобайта плюс
 * сообщение — это меньше потолка ячейки, так что запись ограничена и целиком.
 */
const MAX_ERROR_LINE_CHARS = 4 * 1024

/** Обрезать строку, сказав в ней самой, что она обрезана. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return tr("server.colloqMoreCharactersCutHere.cfc854", { p0: text.slice(0, max), p1: text.length - max })
}

/**
 * Свернуть кадры одной строки: `\r` значит «пиши эту строку заново».
 *
 * tqdm, pip и keras рисуют прогресс возвратом каретки — за десять минут
 * обучения это тысячи кадров одной и той же строки. Панель их сворачивает при
 * показе (`collapseCarriage` в web/src/lib/utils.ts, тот же алгоритм), но по
 * проводу они всё равно ехали и до последнего символа тратили потолок вывода
 * ячейки: настоящий результат обучения обрезался прогресс-баром, который его
 * набрал. В документ уходит последний кадр каждой строки — то, что и видно.
 */
function collapseCarriage(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      let last = ''
      for (const frame of line.split('\r')) if (frame !== '') last = frame
      return last
    })
    .join('\n')
}

export class OutputWriter {
  private pending: Array<{ name: StreamName; text: string }> = []
  private timer: NodeJS.Timeout | null = null
  private used = 0
  private truncated = false
  private noticed = false
  /** Бюджет картинок и прочих mimebundle: считается отдельно от текста. */
  private usedData = 0
  private dataTruncated = false
  private dataNoticed = false
  /**
   * Незакрытая строка в конце документа — та, которую ещё может переписать `\r`.
   *
   * Свернуть кадры внутри одного окна склейки мало: tqdm шлёт кадр в окно, и
   * между окнами строка обязана оставаться той же самой строкой. Поэтому хвост
   * помнится ровно так, как он лежит в Y.Text, и следующий кадр не дописывается
   * за ним, а заменяет его.
   */
  private tailText = ''
  private tailName: StreamName | null = null
  private disposed = false
  /**
   * Обещание: следующая запись не добавляет, а заменяет.
   *
   * Заводится только на `clear_output(wait=True)` — том самом, которым
   * рисуются прогресс-бары и виджеты. Слово «wait» в нём значит «сотри, когда
   * будет чем заменить», а мы стирали сразу: массив пустел немедленно, замена
   * ждала окно склейки, и комната смотрела, как анимация мигает раз двадцать в
   * секунду. Само по себе обещание в документ не пишет ничего.
   */
  private superseded = false
  /**
   * Лёг ли в документ хоть один кусок потока; см. stream().
   *
   * Ставится там, где текст правда дописан (`put`), а не в `write()`: `write()`
   * зовёт и `clear()`, который `runOne` делает в стартовой транзакции ЕЩЁ ДО
   * execute — и признак оказывался поднят раньше первого байта. Первый вывод
   * после этого честно ждал окно склейки, то есть ровно те пятьдесят
   * миллисекунд пустого места, ради которых исключение и заведено.
   */
  private wrote = false

  constructor(
    private readonly doc: Y.Doc,
    private readonly cellId: string,
    /**
     * Потолок картинок этой ячейки — свой у каждого выполнения, потому что
     * зависит от того, сколько человек сейчас в комнате (см. dataBudgetFor).
     */
    private readonly dataBudget: number = MAX_CELL_DATA_CHARS,
  ) {}

  stream(name: StreamName, text: string): void {
    if (this.disposed || !text) return
    /*
     * Упёршаяся в потолок ячейка всё же должна пропустить замену.
     *
     * Раньше здесь стояло `|| this.truncated`, и ячейка, набравшая свои 400 КБ,
     * отказывала каждому следующему куску — включая тот, который должен был
     * выполнить отложенное стирание и сбросить бюджет. Отложенное обещание не
     * срабатывало никогда, и ячейка держала прошлый вывод до конца выполнения.
     * В коротком тесте этого не видно вовсе.
     */
    if (this.truncated && !this.superseded) return
    const last = this.pending[this.pending.length - 1]
    if (last && last.name === name) last.text += text
    else this.pending.push({ name, text })
    /*
     * Первый вывод не ждёт окна склейки.
     *
     * Склейка существует, чтобы двести записей не стали двумястами
     * обновлениями, — а на первом байте она не экономит ничего и стоит ровно
     * тех пятидесяти миллисекунд, которые комната смотрит на пустое место
     * после нажатия. Дальше всё как было.
     *
     * `clear()` этот признак не сбрасывает: иначе перерисовка прогресс-бара
     * начала бы писать без склейки двадцать раз в секунду.
     */
    if (!this.wrote) {
      this.flush()
      return
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, config.outputFlushMs)
    }
  }

  /**
   * Стереть не сейчас, а когда будет чем заменить.
   *
   * `clear_output(wait=True)` — это «сотри в тот момент, когда придёт
   * следующий кадр». Ничего не пишет и ничего не планирует: всю работу делает
   * следующая запись, а если её не будет — конец выполнения (см. dispose).
   */
  supersede(): void {
    if (this.disposed) return
    this.superseded = true
  }

  data(mimebundle: Record<string, string>, execCount: number | null): void {
    if (this.disposed) return
    // Ordering matters more than latency: a print() before a plot must stay before it.
    this.flush()
    // Строка потока закрыта картинкой: дописывать в неё уже некуда.
    this.forgetTail()
    const json = JSON.stringify({ data: mimebundle, execCount })
    this.write((outputs) => {
      if (this.dataTruncated || this.usedData + json.length > this.dataBudget) {
        this.dataTruncated = true
        this.dataNotice(outputs)
        return
      }
      this.usedData += json.length
      const output = new Y.Map<any>()
      output.set('kind', 'data')
      output.set('json', json)
      outputs.push([output])
    })
  }

  error(ename: string, evalue: string, traceback: string[]): void {
    if (this.disposed) return
    this.flush()
    this.forgetTail()
    const lines = traceback.map((line) => clip(line, MAX_ERROR_LINE_CHARS))
    const clipped =
      lines.length > MAX_TRACEBACK_LINES
        ? [...lines.slice(0, 20), tr("server.moreFrames.6caf4c", { p0: lines.length - 60 }), ...lines.slice(-40)]
        : lines
    const json = JSON.stringify({
      ename: clip(ename, MAX_ERROR_LINE_CHARS),
      evalue: clip(evalue, MAX_ERROR_LINE_CHARS),
      traceback: clipped,
    })
    // A traceback is the reason the cell was run; it goes in even past the cap.
    this.write((outputs) => {
      this.used += json.length
      const output = new Y.Map<any>()
      output.set('kind', 'error')
      output.set('json', json)
      outputs.push([output])
    })
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.pending = []
    this.used = 0
    this.truncated = false
    this.noticed = false
    this.usedData = 0
    this.dataTruncated = false
    this.dataNoticed = false
    this.forgetTail()
    // Немедленное стирание отвечает на тот же вопрос, что и отложенное, — и
    // отвечает раньше. Обещание больше не нужно.
    this.superseded = false
    this.write((outputs) => {
      if (outputs.length > 0) outputs.delete(0, outputs.length)
    })
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.length === 0) return
    const chunks = this.pending
    this.pending = []
    this.write((outputs) => {
      for (const chunk of chunks) {
        this.put(outputs, chunk.name, chunk.text)
        if (this.truncated) {
          this.notice(outputs)
          break
        }
      }
    })
  }

  dispose(): void {
    this.flush()
    /*
     * Невыполненное обещание выполняется здесь.
     *
     * Если до конца выполнения так ничего и не пришло, заменять было нечем — а
     * стереть просили. Без этой строки стёртый кадр виджета не возвращался бы
     * никогда: на экране остаётся картинка, которую ядро уже отменило.
     *
     * Именно в dispose, а не третьим методом, который надо помнить: это
     * единственная строка, до которой доходит каждое начатое выполнение —
     * finally у runOne, короткий путь пустой ячейки, catch с KernelError и
     * reportDeadKernel.
     */
    if (this.superseded) this.write(() => {})
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.disposed = true
  }

  /* ------------------------------------------------------------- internals */

  /**
   * One transaction per batch, so peers never render a half-written output —
   * and the cell may have been deleted mid-run, which is not an error.
   */
  private write(mutate: (outputs: Y.Array<YOutput>) => void): void {
    const found = findCell(this.doc, this.cellId)
    if (!found) return
    this.doc.transact(() => {
      const outputs = cellOutputs(found.cell)
      /*
       * Обещание разрешается здесь, до `mutate`, и это существенно.
       *
       * Стереть после — значит дать `append()` подклеить новый кадр в хвост
       * Y.Text старого: получилась бы одна строка «a\nb» без границы, и она
       * поехала бы и в снимок, и в экспорт. Не устаревший кадр, а порча.
       *
       * Бюджет сбрасывается тоже здесь, а не в `supersede()`: сбросить его
       * заранее — значит вернуть упёршейся ячейке её 400 КБ в тот момент,
       * когда на экране ещё висит прошлый вывод.
       */
      if (this.superseded) {
        this.superseded = false
        this.used = 0
        this.truncated = false
        this.noticed = false
        this.usedData = 0
        this.dataTruncated = false
        this.dataNoticed = false
        this.forgetTail()
        if (outputs.length > 0) outputs.delete(0, outputs.length)
      }
      mutate(outputs)
    }, ORIGIN)
  }

  /**
   * Написать кусок потока, свернув кадры возврата каретки вместе с хвостом.
   *
   * Сворачивать надо не кусок, а строку целиком: `abc\r\n` после уже
   * написанного `xy` — это «xyabc» и перевод строки, а не «abc». Поэтому кадры
   * считаются от того, что лежит в документе, и если строка переписана, старая
   * стирается ровно на свою длину.
   */
  private put(outputs: Y.Array<YOutput>, name: StreamName, chunk: string): void {
    this.wrote = true
    let tail = this.tailName === name ? this.tailText : ''
    let text = chunk
    if (chunk.includes('\r')) {
      const folded = collapseCarriage(tail + chunk)
      if (folded.startsWith(tail)) {
        text = folded.slice(tail.length)
      } else if (this.rewind(outputs, name, tail.length)) {
        text = folded
        tail = ''
      } else {
        // Хвоста в документе уже нет — сворачиваем хотя бы то, что пришло.
        text = collapseCarriage(chunk)
      }
    }
    const body = this.budgeted(text)
    if (body) this.append(outputs, name, body)
    const nl = body.lastIndexOf('\n')
    this.tailName = name
    this.tailText = nl < 0 ? tail + body : body.slice(nl + 1)
  }

  /** Хвоста больше нет: за ним в документе легло что-то другое. */
  private forgetTail(): void {
    this.tailText = ''
    this.tailName = null
  }

  /** Стереть незакрытую строку: следующий кадр напишет её заново. */
  private rewind(outputs: Y.Array<YOutput>, name: StreamName, count: number): boolean {
    if (count <= 0) return true
    const last = outputs.length > 0 ? outputs.get(outputs.length - 1) : null
    if (!last || last.get('kind') !== 'stream' || last.get('name') !== name) return false
    const existing = last.get('text')
    if (!(existing instanceof Y.Text) || existing.length < count) return false
    existing.delete(existing.length - count, count)
    this.used -= count
    return true
  }

  private budgeted(text: string): string {
    const room = MAX_CELL_OUTPUT_CHARS - this.used
    if (room <= 0) {
      this.truncated = true
      return ''
    }
    if (text.length <= room) {
      this.used += text.length
      return text
    }
    this.used = MAX_CELL_OUTPUT_CHARS
    this.truncated = true
    return text.slice(0, room)
  }

  /** Growing the tail Y.Text is a few bytes on the wire; a new entry is not. */
  private append(outputs: Y.Array<YOutput>, name: StreamName, text: string): void {
    const last = outputs.length > 0 ? outputs.get(outputs.length - 1) : null
    if (last && last.get('kind') === 'stream' && last.get('name') === name) {
      const existing = last.get('text')
      if (existing instanceof Y.Text) {
        existing.insert(existing.length, text)
        return
      }
    }
    const output = new Y.Map<any>()
    output.set('kind', 'stream')
    output.set('name', name)
    const body = new Y.Text()
    body.insert(0, text)
    output.set('text', body)
    outputs.push([output])
  }

  private notice(outputs: Y.Array<YOutput>): void {
    if (this.noticed) return
    this.noticed = true
    this.forgetTail()
    const output = new Y.Map<any>()
    output.set('kind', 'stream')
    output.set('name', 'stderr' as StreamName)
    const body = new Y.Text()
    body.insert(
      0,
      tr("server.colloqOutputStoppedAfterCharactersSaveThe.cf6866", { p0: MAX_CELL_OUTPUT_CHARS }),
    )
    output.set('text', body)
    outputs.push([output])
  }

  /** Про картинки — своими словами: совет «печатайте в файл» тут ни при чём. */
  private dataNotice(outputs: Y.Array<YOutput>): void {
    if (this.dataNoticed) return
    this.dataNoticed = true
    this.forgetTail()
    const output = new Y.Map<any>()
    output.set('kind', 'stream')
    output.set('name', 'stderr' as StreamName)
    const body = new Y.Text()
    const shown =
      this.dataBudget >= 1024 * 1024
        ? `${Math.round(this.dataBudget / (1024 * 1024))} MB`
        : `${Math.round(this.dataBudget / 1024)} KB`
    body.insert(
      0,
      tr("server.colloqTheImageOutputLimitWasReached.a9f30a", { p0: shown }) +
        tr("server.saveTheFigureToAFileOr.961b0e") +
        tr("server.itsSizeFigsizeDpi.24640a"),
    )
    output.set('text', body)
    outputs.push([output])
  }
}
