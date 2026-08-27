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

/** RecursionError tracebacks run to thousands of identical frames. */
const MAX_TRACEBACK_LINES = 80

export class OutputWriter {
  private pending: Array<{ name: StreamName; text: string }> = []
  private timer: NodeJS.Timeout | null = null
  private used = 0
  private truncated = false
  private noticed = false
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
  /** Была ли в этом выполнении хоть одна запись; см. stream(). */
  private wrote = false

  constructor(
    private readonly doc: Y.Doc,
    private readonly cellId: string,
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
    const json = JSON.stringify({ data: mimebundle, execCount })
    this.write((outputs) => {
      if (this.truncated || this.used + json.length > MAX_CELL_OUTPUT_CHARS) {
        this.truncated = true
        this.notice(outputs)
        return
      }
      this.used += json.length
      const output = new Y.Map<any>()
      output.set('kind', 'data')
      output.set('json', json)
      outputs.push([output])
    })
  }

  error(ename: string, evalue: string, traceback: string[]): void {
    if (this.disposed) return
    this.flush()
    const clipped =
      traceback.length > MAX_TRACEBACK_LINES
        ? [
            ...traceback.slice(0, 20),
            `... ${traceback.length - 60} more frames ...`,
            ...traceback.slice(-40),
          ]
        : traceback
    const json = JSON.stringify({ ename, evalue, traceback: clipped })
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
        const text = this.budgeted(chunk.text)
        if (text) this.append(outputs, chunk.name, text)
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
    this.wrote = true
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
        if (outputs.length > 0) outputs.delete(0, outputs.length)
      }
      mutate(outputs)
    }, ORIGIN)
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
    const output = new Y.Map<any>()
    output.set('kind', 'stream')
    output.set('name', 'stderr' as StreamName)
    const body = new Y.Text()
    body.insert(
      0,
      `\n[colloq] output stopped after ${Math.round(MAX_CELL_OUTPUT_CHARS / 1024)} KB — write to a file instead of printing.\n`,
    )
    output.set('text', body)
    outputs.push([output])
  }
}
