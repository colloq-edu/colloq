import { tr } from '@shared/i18n'
import * as Y from 'yjs'
import { cellOutputs, findCell, type OutputBlob, type StreamName, type YOutput } from '@shared/notebook'
import { SPILL_MIMES, spillEncoding } from '@shared/publish'
import { putBlob } from '../blobs.js'
import { config } from '../config.js'
import {
  MAX_FIGURE_CHARS,
  figureChars,
  figureTooBigNotice,
  withoutDeadPlotlyHtml,
  withoutFigure,
} from './figures.js'

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
 * Images have a budget of their own, and it is larger.
 *
 * One `plt.imshow` at dpi=200 is a megabyte or two of base64, i.e. more than
 * the whole text ceiling at once. Paying for them from one wallet would mean
 * answering a computer vision seminar with "output stopped after 400 KB —
 * write to a file instead of printing" instead of the image the cell was run
 * for, and silencing every later print of that cell along the way. The price
 * is known: the same amount travels to everyone in the room, into the
 * snapshot and into the history keyframe, so the budget is per cell, not per
 * frame, and not "however much we get".
 */
const MAX_CELL_DATA_CHARS = 6 * 1024 * 1024

/**
 * The room that gets this budget in full.
 *
 * The cost of an image is not its size but its size times the number of open
 * tabs: one two-megabyte `imshow` in a room of five hundred people is a
 * gigabyte of egress and five hundred independent deflate jobs, behind which
 * ALL other edits queue up, typing included. In a seminar of thirty it is
 * sixty megabytes and bothers nobody, so the ceiling is not the same for
 * everyone: up to this number of viewers it stays as it was.
 */
const FULL_DATA_BUDGET_VIEWERS = 40
/**
 * We never go below this, whatever the audience: an ordinary matplotlib image
 * (default `figsize`, dpi 100) is a hundred or two kilobytes, and a lecture
 * where it cannot be shown at all is no better than a lecture that lags.
 */
const MIN_CELL_DATA_CHARS = 768 * 1024

/**
 * How many images a cell is allowed to show, with an eye on how many people
 * they will travel to. A pure function: there is nothing to compute it from
 * but the number of viewers, and it is the rule itself that needs testing.
 */
export function dataBudgetFor(viewers: number): number {
  if (!Number.isFinite(viewers) || viewers <= FULL_DATA_BUDGET_VIEWERS) return MAX_CELL_DATA_CHARS
  const scaled = Math.round((MAX_CELL_DATA_CHARS * FULL_DATA_BUDGET_VIEWERS) / viewers)
  return Math.max(MIN_CELL_DATA_CHARS, scaled)
}

/**
 * The threshold past which an image leaves the document for outside storage
 * (`server/blobs.ts`).
 *
 * Sixteen kilobytes of base64 are twelve kilobytes of bytes: less than that is
 * an icon or a small sprite, for which a separate request costs more than its
 * own size, and anything bigger is already a plot. Text, HTML and SVG are
 * never moved out: the room shows the first two as markup and sanitises them
 * in place, and a link to them would be a second round of loading for the
 * sake of a kilobyte.
 */
const BLOB_FROM_CHARS = 16 * 1024

/**
 * How many times cheaper an image moved out of the document is for the room
 * than one lying in it.
 *
 * The cell still has one budget (`dataBudget`), and that is right: it is about
 * how much the room is prepared to pay for one cell's output. But a link costs
 * differently from base64 in the document: the document does not carry it at
 * all, neither do the snapshot and the history frame, no zlib is spent per
 * viewer, and the image travels once, as a separate request, and then lives
 * in the browser cache. Only the egress traffic remains, roughly an eighth of
 * the former price. So the moved-out bytes are counted at one eighth: a cell
 * that used to hit the ceiling at six megabytes of images now draws
 * forty-eight.
 */
const BLOB_BUDGET_FACTOR = 8

/**
 * What one link costs the document: a sixty-four-character hash, the type, the
 * weight and the quotes around them, with a margin. Counted before the write
 * to disk, when there is no hash yet but the budget already has to be decided.
 */
const REF_CHARS = 150

/** RecursionError tracebacks run to thousands of identical frames. */
const MAX_TRACEBACK_LINES = 80
/**
 * The length of one error line: both `evalue` and each traceback frame.
 *
 * An error bypasses the cell ceiling, because it is the very reason for the
 * run, but that does not mean "as much as you like".
 * `assert len(rows) == 0, rows` on a list of a million elements puts megabytes
 * into `evalue` and into the last traceback line, and from there into all
 * thirty browsers, the snapshot and every history keyframe. Eighty frames of
 * four kilobytes plus the message are less than the cell ceiling, so the
 * record as a whole is bounded too.
 */
const MAX_ERROR_LINE_CHARS = 4 * 1024

/** Cut a line, saying in the line itself that it was cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return tr("server.colloqMoreCharactersCutHere.cfc854", { p0: text.slice(0, max), p1: text.length - max })
}

/**
 * Collapse the frames of one line: `\r` means "write this line again".
 *
 * tqdm, pip and keras draw progress with carriage returns: over ten minutes of
 * training that is thousands of frames of the same line. The panel collapses
 * them for display (`collapseCarriage` in web/src/lib/utils.ts, the same
 * algorithm), but they still travelled over the wire and used up the cell's
 * output ceiling down to the last character: the real training result was cut
 * off by the progress bar that had filled the ceiling. The document gets the
 * last frame of each line, which is what is visible anyway.
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
  /** The budget for images and other mimebundles: counted apart from text. */
  private usedData = 0
  private dataTruncated = false
  private dataNoticed = false
  /**
   * The unfinished line at the end of the document, the one a `\r` may still
   * rewrite.
   *
   * Collapsing frames inside one coalescing window is not enough: tqdm sends a
   * frame per window, and between windows the line must stay the same line. So
   * the tail is remembered exactly as it lies in the Y.Text, and the next frame
   * is not appended after it but replaces it.
   */
  private tailText = ''
  private tailName: StreamName | null = null
  private disposed = false
  /**
   * A promise: the next write does not add but replaces.
   *
   * Set only on `clear_output(wait=True)`, the very call progress bars and
   * widgets are drawn with. The word "wait" in it means "erase when there is
   * something to replace it with", but we erased right away: the array went
   * empty immediately, the replacement waited for the coalescing window, and
   * the room watched the animation blink twenty times a second. By itself the
   * promise writes nothing into the document.
   */
  private superseded = false
  /**
   * Whether at least one stream chunk has landed in the document; see stream().
   *
   * Set where text is really appended (`put`), not in `write()`: `write()` is
   * also called by `clear()`, which `runOne` does in the starting transaction
   * EVEN BEFORE execute, and the flag ended up raised before the first byte.
   * The first output after that dutifully waited for the coalescing window,
   * i.e. exactly the fifty milliseconds of empty space the exception exists to
   * avoid.
   */
  private wrote = false

  constructor(
    private readonly doc: Y.Doc,
    private readonly cellId: string,
    /**
     * This cell's image ceiling, its own for each execution, because it depends
     * on how many people are in the room right now (see dataBudgetFor).
     */
    private readonly dataBudget: number = MAX_CELL_DATA_CHARS,
    /**
     * The room next to which moved-out images will be stored.
     *
     * Optional, and not by forgetfulness: a writer without a room (tests, the
     * emergency writer of a dead kernel) writes everything into the document,
     * as before. The storage is addressed by seminar; without one there is
     * nowhere to move anything to.
     */
    private readonly sessionId: string | null = null,
  ) {}

  stream(name: StreamName, text: string): void {
    if (this.disposed || !text) return
    /*
     * A cell that has hit the ceiling must still let a replacement through.
     *
     * There used to be `|| this.truncated` here, and a cell that had used up
     * its 400 KB refused every next chunk, including the one that was supposed
     * to carry out the deferred erase and reset the budget. The deferred
     * promise never fired, and the cell kept its previous output until the end
     * of the execution. In a short test this does not show at all.
     */
    if (this.truncated && !this.superseded) return
    const last = this.pending[this.pending.length - 1]
    if (last && last.name === name) last.text += text
    else this.pending.push({ name, text })
    /*
     * The first output does not wait for the coalescing window.
     *
     * Coalescing exists so that two hundred writes do not become two hundred
     * updates, but on the first byte it saves nothing and costs exactly the
     * fifty milliseconds the room spends looking at empty space after the
     * click. After that everything is as before.
     *
     * `clear()` does not reset this flag: otherwise redrawing a progress bar
     * would start writing without coalescing twenty times a second.
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
   * Erase not now, but when there is something to replace it with.
   *
   * `clear_output(wait=True)` means "erase at the moment the next frame
   * arrives". It writes nothing and schedules nothing: all the work is done by
   * the next write, and if there is none, by the end of the execution (see
   * dispose).
   */
  supersede(): void {
    if (this.disposed) return
    this.superseded = true
  }

  data(mimebundle: Record<string, string>, execCount: number | null): void {
    if (this.disposed) return
    // Ordering matters more than latency: a print() before a plot must stay before it.
    this.flush()
    // An image closes the stream line: there is nothing left to append to.
    this.forgetTail()
    /*
     * A plotly figure comes before all other calculations, for two different
     * reasons.
     *
     * First: next to it the kernel sends `text/html`, hundreds of kilobytes of
     * script the product will never execute (kernel/figures.ts). In the
     * document it would land at full weight, and on every plot.
     *
     * Second: a figure has its own ceiling on top of the cell budget. JSON
     * cannot be cut (a truncated figure is not "part of a plot" but a broken
     * frame), so its place is taken by a line that says what happened and what
     * to do.
     */
    let bundle = withoutDeadPlotlyHtml(mimebundle)
    const chars = figureChars(bundle)
    const oversize = chars > MAX_FIGURE_CHARS ? chars : 0
    if (oversize > 0) bundle = withoutFigure(bundle)
    /*
     * Decode before the transaction, put inside it.
     *
     * Inside a transaction the document is closed to everyone else, and
     * `Buffer.from` on a megabyte of base64 there takes milliseconds, behind
     * which a queue of other people's typing builds up. But the decision "put
     * it or not" depends on the budget, which the deferred erase resets exactly
     * at the start of the transaction (see `write`), so it is made there.
     */
    const heavy = this.heavyParts(bundle)
    this.write((outputs) => {
      if (oversize > 0) this.say(outputs, figureTooBigNotice(oversize))
      // The bundle may have held only a figure, and that did not fit: then
      // there is no data record at all, only the line above.
      if (Object.keys(bundle).length === 0) return
      const inline: Record<string, string> = {}
      for (const [mime, value] of Object.entries(bundle)) {
        if (!heavy.has(mime)) inline[mime] = value
      }
      /*
       * First the price, then the write to disk.
       *
       * Otherwise a cell that hit the ceiling would leave a file behind for
       * every image it was not allowed to show: they will never get into the
       * document, and nobody would remove them until the seminar is deleted.
       */
      let spilled = 0
      for (const body of heavy.values()) spilled += body.length
      const cost =
        JSON.stringify({ data: inline, execCount }).length +
        heavy.size * REF_CHARS +
        Math.ceil(spilled / BLOB_BUDGET_FACTOR)
      if (this.dataTruncated || this.usedData + cost > this.dataBudget) {
        this.dataTruncated = true
        this.dataNotice(outputs)
        return
      }
      const blobs: OutputBlob[] = []
      for (const [mime, body] of heavy) {
        const stored = this.sessionId ? putBlob(this.sessionId, body) : null
        if (!stored) {
          // Not written: the image still travels, just the old way. Losing it
          // because of a full disk is worse than paying for it in the document.
          inline[mime] = bundle[mime]
          continue
        }
        blobs.push({ sha: stored.sha, mime, bytes: stored.bytes })
      }
      const json = JSON.stringify(
        blobs.length > 0 ? { data: inline, blobs, execCount } : { data: inline, execCount },
      )
      this.usedData += cost
      const output = new Y.Map<any>()
      output.set('kind', 'data')
      output.set('json', json)
      outputs.push([output])
    })
  }

  /**
   * Which parts of the bundle will travel by link, already decoded.
   *
   * Raster images and plotly figures (`SPILL_MIMES`), and only large ones: the
   * rest is cheaper to leave in the document than to fetch with a second
   * request. The same list publishing uses to move content out, so that the
   * same things travel by link in the room and on a published page.
   *
   * Their encoding differs and is looked up by type (`spillEncoding`): an
   * image arrives as base64, a figure as JSON text. Decoding text as base64
   * gives garbage in the record and an empty frame on screen, the very trouble
   * that keeps SVG in a record from being moved out at all.
   */
  private heavyParts(mimebundle: Record<string, string>): Map<string, Uint8Array> {
    const heavy = new Map<string, Uint8Array>()
    if (!this.sessionId) return heavy
    for (const [mime, value] of Object.entries(mimebundle)) {
      if (typeof value !== 'string' || value.length < BLOB_FROM_CHARS) continue
      if (!SPILL_MIMES.has(mime)) continue
      const body = Buffer.from(value, spillEncoding(mime))
      // Empty after decoding means not an image but something the kernel called
      // an image: let it go into the document and be sorted out there.
      if (body.length > 0) heavy.set(mime, body)
    }
    return heavy
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
    // An immediate erase answers the same question as a deferred one, and
    // answers it earlier. The promise is no longer needed.
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
     * An unfulfilled promise is fulfilled here.
     *
     * If nothing at all arrived by the end of the execution, there was nothing
     * to replace with, but erasing was requested. Without this line a widget
     * frame's erase would never happen: the screen keeps an image the kernel
     * has already cancelled.
     *
     * In dispose precisely, not in a third method one has to remember: this is
     * the only line every started execution reaches: runOne's finally, the
     * short path of an empty cell, the catch with KernelError, and
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
       * The promise is resolved here, before `mutate`, and this matters.
       *
       * Erasing afterwards would let `append()` glue the new frame onto the
       * tail of the old Y.Text: the result would be one line "a\nb" with no
       * boundary, and it would travel into the snapshot and the export too. Not
       * a stale frame, but corruption.
       *
       * The budget is reset here too, not in `supersede()`: resetting it in
       * advance would give a cell at the ceiling its 400 KB back while the
       * previous output is still on screen.
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
   * Write a stream chunk, collapsing carriage-return frames together with the
   * tail.
   *
   * It is the whole line that must be collapsed, not the chunk: `abc\r\n` after
   * an already written `xy` is "xyabc" and a newline, not "abc". So the frames
   * are counted from what lies in the document, and if the line is rewritten,
   * the old one is erased by exactly its own length.
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
        // The tail is no longer in the document: collapse at least what came.
        text = collapseCarriage(chunk)
      }
    }
    const body = this.budgeted(text)
    if (body) this.append(outputs, name, body)
    const nl = body.lastIndexOf('\n')
    this.tailName = name
    this.tailText = nl < 0 ? tail + body : body.slice(nl + 1)
  }

  /** The tail is gone: something else landed after it in the document. */
  private forgetTail(): void {
    this.tailText = ''
    this.tailName = null
  }

  /** Erase the unfinished line: the next frame will write it anew. */
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

  /**
   * A word from the product, not from Python, as a separate stderr stream
   * record.
   *
   * One for all the explanations below: truncated text, an exhausted image
   * budget, a figure that did not fit. The tail is always forgotten: nothing
   * can be appended to a line after which our line has landed.
   */
  private say(outputs: Y.Array<YOutput>, text: string): void {
    this.forgetTail()
    const output = new Y.Map<any>()
    output.set('kind', 'stream')
    output.set('name', 'stderr' as StreamName)
    const body = new Y.Text()
    body.insert(0, text)
    output.set('text', body)
    outputs.push([output])
  }

  private notice(outputs: Y.Array<YOutput>): void {
    if (this.noticed) return
    this.noticed = true
    this.say(
      outputs,
      tr("server.colloqOutputStoppedAfterCharactersSaveThe.cf6866", { p0: MAX_CELL_OUTPUT_CHARS }),
    )
  }

  /** About images, in its own words: the "print to a file" advice is beside the point. */
  private dataNotice(outputs: Y.Array<YOutput>): void {
    if (this.dataNoticed) return
    this.dataNoticed = true
    const shown =
      this.dataBudget >= 1024 * 1024
        ? `${Math.round(this.dataBudget / (1024 * 1024))} MB`
        : `${Math.round(this.dataBudget / 1024)} KB`
    this.say(
      outputs,
      tr("server.colloqTheImageOutputLimitWasReached.a9f30a", { p0: shown }) +
        tr("server.saveTheFigureToAFileOr.961b0e") +
        tr("server.itsSizeFigsizeDpi.24640a"),
    )
  }
}
