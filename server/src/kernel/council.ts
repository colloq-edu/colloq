import { tr } from '@shared/i18n'
/**
 * A council attempt's output goes to memory, not to a shared cell.
 *
 * OutputWriter (outputs.ts) writes into the cell's Y.Array, because the whole
 * room watches a cell's output. An attempt's output is watched by two people,
 * the teacher and the author, and putting it into the shared document would
 * show the audience what the teacher has not yet decided to show. So an
 * attempt has its own receiver: the same kernel handlers, the same order of
 * records, but the result is a plain `CellOutput` array that control.ts
 * attaches to the attempt (council.ts · recordRun) and broadcasts over the
 * control socket.
 *
 * The ceilings are lower than a cell's, on purpose: an attempt card is drawn
 * in a stack of hundreds, and each of its frames travels to the host whole,
 * together with the entire stack. A four-hundred-kilobyte progress bar does
 * not fit there and is not needed.
 *
 * A pure module without Yjs and without network, for the sake of the test.
 */
import type { CellOutput, StreamName } from '@shared/notebook'
import type { CouncilRun } from '@shared/protocol'
import {
  figureChars,
  figureTooBigNotice,
  withoutDeadPlotlyHtml,
  withoutFigure,
} from './figures.js'

/** This much attempt text still reads on a card; past it, a tip to write a file. */
export const MAX_ATTEMPT_OUTPUT_CHARS = 64 * 1024
/** One matplotlib image fits; a gallery does not. */
export const MAX_ATTEMPT_DATA_CHARS = 2 * 1024 * 1024
const MAX_TRACEBACK_LINES = 60
const MAX_ERROR_LINE_CHARS = 2 * 1024

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return tr("server.colloqMoreCharactersCutHere.cfc854", { p0: text.slice(0, max), p1: text.length - max })
}

/** What the kernel needs to compute an attempt, and whom to tell the result. */
export interface CouncilJob {
  /** The council cell the attempt belongs to (not the queue's synthetic id). */
  cellId: string
  participantId: string
  source: string
  by: CouncilRun['by']
  /**
   * The limit of one run in seconds; `null` means no limit.
   *
   * It travels with the job instead of being read by the kernel from the cell:
   * the knobs live in the document, and from here the document is reachable
   * only through control.ts, the very module that calls the kernel. An import
   * back would tie the two to each other, and for the sake of one number. The
   * number is taken at the second of the click; rules changed in the middle of
   * a run arrive separately (kernel/index.ts · retimeCouncilRun).
   */
  limitSec: number | null
  /**
   * Every state change and every output frame. `null`: the attempt was taken
   * off the queue without running (a kernel restart, a room-wide "stop"):
   * there was no run, and there must be no record of one.
   */
  onChange: (run: CouncilRun | null) => void
}

export class CouncilOutputBuffer {
  private outputs: CellOutput[] = []
  private used = 0
  private usedData = 0
  private truncated = false
  private dataTruncated = false
  /** Promised `clear_output(wait=True)`: the next record replaces, not appends. */
  private superseded = false

  stream(name: StreamName, text: string): void {
    if (!text) return
    this.settle()
    if (this.truncated) return
    const room = MAX_ATTEMPT_OUTPUT_CHARS - this.used
    let body = text
    // Strictly greater: text that fits the budget exactly is not cut by a
    // single character, and declaring it truncated would be a lie that throws
    // away everything that comes next. A budget filled exactly hits the
    // ceiling on the next chunk, where truncation really does happen.
    if (text.length > room) {
      body = text.slice(0, Math.max(0, room))
      this.truncated = true
    }
    this.used += body.length
    if (body) this.append(name, body)
    if (this.truncated) {
      this.outputs.push({
        kind: 'stream',
        name: 'stderr',
        text: tr("server.colloqAttemptOutputStoppedAfterCharactersSave.97282a", { p0: MAX_ATTEMPT_OUTPUT_CHARS }),
      })
    }
  }

  data(mimebundle: Record<string, string>, execCount: number | null): void {
    this.settle()
    /*
     * A plotly plot in an attempt goes whole or as a line; there is no third
     * way.
     *
     * An attempt has no record shelf and cannot have one: its output lives in
     * memory and travels to the host over the control socket together with the
     * whole stack (see the file header). So a figure either fits under the
     * card's ceiling and travels as is, or does not travel at all, and then the
     * same honest line as in the room takes its place. JSON cannot be cut: that
     * is not "part of a plot" but a broken frame.
     *
     * Plotly's dead markup is stripped by the same rule as in the room, and
     * before weighing: otherwise the card budget would be eaten by a script
     * nobody will ever execute.
     */
    let bundle = withoutDeadPlotlyHtml(mimebundle)
    const figure = figureChars(bundle)
    if (figure > 0 && figure > MAX_ATTEMPT_DATA_CHARS) {
      bundle = withoutFigure(bundle)
      this.outputs.push({ kind: 'stream', name: 'stderr', text: figureTooBigNotice(figure) })
      if (Object.keys(bundle).length === 0) return
    }
    const size = JSON.stringify(bundle).length
    if (this.dataTruncated || this.usedData + size > MAX_ATTEMPT_DATA_CHARS) {
      if (!this.dataTruncated) {
        this.outputs.push({
          kind: 'stream',
          name: 'stderr',
          text: tr("server.colloqTheAttemptImageLimitWasReached.3d579d"),
        })
      }
      this.dataTruncated = true
      return
    }
    this.usedData += size
    this.outputs.push({ kind: 'data', data: bundle, execCount })
  }

  error(ename: string, evalue: string, traceback: string[]): void {
    this.settle()
    const lines = traceback.map((line) => clip(line, MAX_ERROR_LINE_CHARS))
    const clipped =
      lines.length > MAX_TRACEBACK_LINES
        ? [...lines.slice(0, 20), tr("server.moreFrames.6caf4c", { p0: lines.length - 50 }), ...lines.slice(-30)]
        : lines
    this.outputs.push({
      kind: 'error',
      ename: clip(ename, MAX_ERROR_LINE_CHARS),
      evalue: clip(evalue, MAX_ERROR_LINE_CHARS),
      traceback: clipped,
    })
  }

  /**
   * The run was stopped by the rules, and it is not a traceback that should
   * say so.
   *
   * SIGINT arrives in Python as `KeyboardInterrupt`, and by default the card
   * would keep its traceback: a dozen frames of someone else's library and a
   * line about a keyboard nobody pressed. A student reads that as "the teacher
   * pressed stop" or as their own mistake, while the truth is "the run limit".
   * So the interrupt exception is removed, and our own takes its place, in one
   * line and without a traceback.
   *
   * ONLY the interrupt is removed: everything the attempt managed to print
   * before the stop is its real output, and that is usually where the answer
   * to "where did it loop" is. `settle()` is deliberately not called here:
   * there is nothing to fulfil the progress bar's `clear_output(wait=True)`
   * promise with, and erasing what was printed for the sake of a stop line is
   * a loss with no gain.
   */
  stopped(evalue: string): void {
    this.outputs = this.outputs.filter(
      (o) => !(o.kind === 'error' && (o.ename === 'KeyboardInterrupt' || o.ename === 'Interrupted')),
    )
    /*
     * The exception name is empty on purpose: the card draws "name: text", and
     * the student read "TimeLimit: Остановлено: …", an English word in front
     * of a Russian phrase that adds nothing. The machine-readable stop mark is
     * `CouncilRun.timedOut`; nobody looks for it by the error name.
     */
    this.outputs.push({ kind: 'error', ename: '', evalue, traceback: [] })
  }

  /** `clear_output(wait=False)`: erase now. */
  clear(): void {
    this.outputs = []
    this.used = 0
    this.usedData = 0
    this.truncated = false
    this.dataTruncated = false
    this.superseded = false
  }

  /** `clear_output(wait=True)`: erase once there is something to replace it. */
  supersede(): void {
    this.superseded = true
  }

  /** An exception is already there: do not add a second one about the interrupt. */
  get hasError(): boolean {
    return this.outputs.some((o) => o.kind === 'error')
  }

  /** Copy out: the array leaves as JSON and into the DB; the buffer lives on. */
  snapshot(): CellOutput[] {
    return this.outputs.map((o) => ({ ...o }))
  }

  private settle(): void {
    if (!this.superseded) return
    this.clear()
  }

  /** Adjacent chunks of one stream become one record, as in the document. */
  private append(name: StreamName, text: string): void {
    const last = this.outputs[this.outputs.length - 1]
    if (last && last.kind === 'stream' && last.name === name) {
      last.text += text
      return
    }
    this.outputs.push({ kind: 'stream', name, text })
  }
}
