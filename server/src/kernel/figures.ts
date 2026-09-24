import { tr } from '@shared/i18n'
import { PLOTLY_MIME } from '@shared/plotly'

/**
 * What to do with a plotly figure on its way from the kernel to the document.
 *
 * A shared place for the two output receivers, room cells (`outputs.ts`) and
 * council attempts (`council.ts`): the decisions here are the same, but the
 * ceilings differ, so the ceiling comes in as a parameter.
 *
 * A pure module without Yjs and without disk, for the sake of the test.
 */

/**
 * How many JSON characters a single figure is allowed.
 *
 * Twelve megabytes is roughly half a million scatter points in plotly.py's
 * binary packing (`{"dtype":"f8","bdata":…}`), i.e. clearly more than
 * anything worth showing a person on a projector. Beyond that the price is
 * paid not in drawing but in the figure travelling to everyone in the room
 * and landing in every history frame, and it is paid silently, because
 * plotly.js honestly tries to draw even a million.
 *
 * The ceiling stands NEXT TO the cell budget, not instead of it: a figure
 * moved out of the cell counts against that budget at one eighth, like an
 * image, so two such figures in one cell still hit the shared limit.
 */
export const MAX_FIGURE_CHARS = 12 * 1024 * 1024

/**
 * The markup plotly uses to bootstrap itself into the classic notebook.
 *
 * The `notebook` renderer (plotly 5.x's default under ipykernel) sends, before
 * the first plot, a `display_data` with a single `text/html` key, and it holds
 * the ENTIRE plotly.js bundle, five megabytes of script. We do not execute
 * scripts: the sanitizer cuts them out, an empty space remains on screen, and
 * meanwhile the five megabytes land in the shared document, travel to
 * everyone in the room and eat the whole output budget of the cell, the very
 * cell whose plot all this was for.
 *
 * Recognised by plotly's own signature at the start of the block. There is
 * almost nothing to get wrong here: only plotly writes `window.PlotlyConfig`,
 * and only in this block.
 */
function isPlotlyBootstrap(html: string): boolean {
  return html.length > 64 * 1024 && html.slice(0, 4096).includes('window.PlotlyConfig')
}

/**
 * The bundle without plotly's dead markup.
 *
 * Two cases, both hundreds of kilobytes (or even megabytes) of script the
 * product will never execute:
 *
 *  1. a `text/html` arrived next to the figure: that is the `plotly_mimetype+
 *     notebook` renderer; the frame will draw the figure, and the markup is
 *     entirely superfluous here;
 *  2. the bootstrap of the `notebook` renderer, see `isPlotlyBootstrap`.
 *
 * A new object is returned: the bundle comes from parsing a kernel frame, and
 * touching it in place would mean fixing someone else's record after the fact.
 */
export function withoutDeadPlotlyHtml(bundle: Record<string, string>): Record<string, string> {
  const html = bundle['text/html']
  if (html === undefined) return bundle
  const dead = bundle[PLOTLY_MIME] !== undefined || isPlotlyBootstrap(html)
  if (!dead) return bundle
  const out: Record<string, string> = {}
  for (const [mime, value] of Object.entries(bundle)) if (mime !== 'text/html') out[mime] = value
  return out
}

/** How many characters the figure in this bundle has. `0`: it has no figure. */
export function figureChars(bundle: Record<string, string>): number {
  return bundle[PLOTLY_MIME]?.length ?? 0
}

/**
 * An honest line instead of a plot that cannot be shipped.
 *
 * A line precisely, not silence and not truncated JSON: a truncated figure is
 * a broken frame for which plotly.js will show emptiness, and silence reads as
 * "the cell printed nothing". Its advice is a real way out, not an excuse:
 * `fig.write_html` puts the plot into a file next to the notebook, and that
 * file can be opened.
 */
export function figureTooBigNotice(chars: number): string {
  const mb = Math.max(1, Math.round(chars / (1024 * 1024)))
  return tr('server.output.plotlyTooBig', { p0: mb })
}

/** The bundle without its figure: it did not fit, and a line replaces it. */
export function withoutFigure(bundle: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [mime, value] of Object.entries(bundle)) if (mime !== PLOTLY_MIME) out[mime] = value
  return out
}
