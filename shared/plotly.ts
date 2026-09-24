/**
 * An interactive plotly chart: one mime, one frame, one way to describe it.
 *
 * The kernel sends the figure as a type of its own —
 * `application/vnd.plotly.v1+json` — rather than as a picture or markup.
 * While the product did not know about it, a cell with `px.histogram(...)`
 * output NOTHING, and that is no exaggeration: the bundle from ipykernel with
 * current plotly (7.x, the `plotly_mimetype` renderer) holds exactly one key —
 * the figure itself. No `text/plain`, no picture. Choosing the representation
 * (`web/src/components/notebook/output-mimes.ts · pickMime`) found nothing
 * familiar and returned `null`, and `null` is drawn as an empty space.
 *
 * With the old renderer (`plotly_mimetype+notebook`, the plotly 5.x default)
 * it was empty for another reason: there the figure came with a `text/html`
 * carrying a script — and the sanitizer cut the script out, leaving an empty
 * `<div>`.
 *
 * RENDERING HAPPENS IN A SANDBOX, and that is not caution in general but a
 * property of the subject. The figure is built by a library running in the
 * code of anyone who is allowed to run things in the room (SECURITY.md: cell
 * output is untrusted data), and plotly.js is a five-megabyte foreign surface
 * that parses pseudo-HTML in labels, follows links and loads images by
 * address. Between it and the class page stands an `<iframe>` with an opaque
 * origin: no cookies, no `localStorage`, no parent DOM, no network (see
 * `server/src/plotly-frame.ts`).
 *
 * Here lives what BOTH sides must know: the type name, the addresses of the
 * frame and the bundle, reducing a figure to what travels inside, and the
 * shape of the messages. There is nowhere for them to drift apart — and a
 * message that fails to parse fails silently.
 */

/** The type by which the kernel names a figure. Written into the document as a JSON string. */
export const PLOTLY_MIME = 'application/vnd.plotly.v1+json'

/**
 * The plotly.js bundle — from our origin, at a fixed address.
 *
 * The file is put into `web/public/plotly/` by the `plotly:dist` script
 * (web/package.json) — the same trick as for the pdf.js worker. A fixed
 * address is needed by TWO sides at once: the frame's markup refers to it and
 * it also sits in the frame's `script-src`, while the header is built by the
 * server, which knows nothing about the frontend build.
 *
 * No CDNs. Cloudflare and half of the rest are unreachable from Russia
 * (memory: cloudflare-blocked-from-russia), and a classroom without internet
 * is an ordinary thing: `cdn.plot.ly` in such a room means an empty space
 * instead of a chart.
 */
export const PLOTLY_BUNDLE_PATH = '/plotly/plotly.min.js'

/**
 * The address of the frame page.
 *
 * A server route, not a file in `public/`, because the frame has ITS OWN
 * `Content-Security-Policy` header with the `sandbox` directive — and that
 * one, unlike the others, cannot be set from `<meta>` (the specification
 * ignores it there). Under `/api/` so that in development the request goes to
 * the server through the same Vite proxy as the rest of the API, and the
 * address is the same in both modes.
 */
export const PLOTLY_FRAME_PATH = '/api/plotly/frame'

/**
 * Where the frame is allowed to take its script from — as a query parameter.
 *
 * In a sandbox the document's origin is opaque, and `'self'` in such a policy
 * has nothing to rest on: the address in `script-src` must be explicit. The
 * server does not know it — there may be a relay in front of it, Vite on
 * 5173 or bare localhost — but the page knows everything about itself, so the
 * origin comes from the page.
 *
 * There is nothing to forge with this: the `<script src>` inside the frame is
 * the fixed address above, that is, OUR origin. A foreign value will only
 * forbid the bundle (the frame will honestly say it did not load), not
 * replace it.
 */
export const PLOTLY_ORIGIN_PARAM = 'o'

/** `http(s)://host[:port]` and nothing more — what goes into the header. */
export const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9._-]{1,255}(?::\d{1,5})?$/

/**
 * The height of a chart nobody asked a height for.
 *
 * Plotly draws 450 pixels by default (`layout.height`), and the frame needs
 * the same number BEFORE the bundle arrives: the space for the chart is
 * reserved in advance, otherwise the notebook jumps on every load.
 */
export const PLOTLY_DEFAULT_HEIGHT = 450

/** Below this a chart stops being a chart; above it, it takes the whole screen. */
export const PLOTLY_MIN_HEIGHT = 180
export const PLOTLY_MAX_HEIGHT = 2400

/**
 * The figure in the form it travels into the frame.
 *
 * Three fields, and only these: `config` inside the figure is someone else's
 * settings for our toolbar (up to `plotlyServerURL` and the "send to Chart
 * Studio" button), and everything else in the figure object is none of our
 * business at all.
 */
export interface PlotlyFigure {
  data: unknown[]
  layout: Record<string, unknown>
  frames?: unknown[]
}

/**
 * Reduce what the kernel sent to a figure — or refuse.
 *
 * An allowlist, not subtraction: a field plotly introduces tomorrow must not
 * travel into the frame by itself. `null` is not a figure, and there is
 * nothing to show it with.
 */
export function normalizeFigure(value: unknown): PlotlyFigure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.data)) return null
  const layout =
    raw.layout && typeof raw.layout === 'object' && !Array.isArray(raw.layout)
      ? (raw.layout as Record<string, unknown>)
      : {}
  const figure: PlotlyFigure = { data: raw.data, layout }
  if (Array.isArray(raw.frames)) figure.frames = raw.frames
  return figure
}

/** The height from the figure — with a ceiling and a floor, because the number comes from outside. */
export function figureHeight(figure: PlotlyFigure): number {
  const asked = figure.layout.height
  if (typeof asked !== 'number' || !Number.isFinite(asked)) return PLOTLY_DEFAULT_HEIGHT
  return Math.min(PLOTLY_MAX_HEIGHT, Math.max(PLOTLY_MIN_HEIGHT, Math.round(asked)))
}

/* ---------------------------------------------------------- figure summary */

/**
 * How many numbers are in one field of a trace.
 *
 * Since version six plotly.py encodes numpy arrays as binary: instead of a
 * list the JSON holds `{"dtype":"f8","bdata":"<base64>"}`. A hundred thousand
 * points weigh half as much that way — and you can no longer ask them for
 * their length with `.length`.
 */
const ITEM_BYTES: Record<string, number> = {
  i1: 1, u1: 1, i2: 2, u2: 2, f2: 2, i4: 4, u4: 4, f4: 4, i8: 8, u8: 8, f8: 8,
}

function fieldLength(value: unknown): number {
  if (Array.isArray(value)) return value.length
  if (!value || typeof value !== 'object') return 0
  const packed = value as { dtype?: unknown; bdata?: unknown }
  if (typeof packed.bdata !== 'string' || typeof packed.dtype !== 'string') return 0
  const size = ITEM_BYTES[packed.dtype]
  if (!size) return 0
  // base64: four characters per three bytes; trailing "=" do not count.
  const padding = packed.bdata.endsWith('==') ? 2 : packed.bdata.endsWith('=') ? 1 : 0
  return Math.round(((packed.bdata.length * 3) / 4 - padding) / size)
}

/** What a figure is — without its contents. */
export interface FigureShape {
  /** The type of the first trace: histogram, box, scatter, … */
  kind: string
  traces: number
  points: number
}

/**
 * A one-line summary of a figure — for the oracle and for the log.
 *
 * The model has no use for a megabyte of coordinates (it will not read them
 * anyway, and they would eat the whole context budget), but it does need to
 * know "there was a chart here": a cell with a single `px.scatter(...)`
 * otherwise looks like a cell that printed nothing. Exactly the same argument
 * by which `[image/png, ~120 KB image]` goes into the context instead of
 * pixels.
 */
export function figureShape(figure: PlotlyFigure): FigureShape {
  let points = 0
  let kind = 'scatter'
  figure.data.forEach((one, index) => {
    if (!one || typeof one !== 'object') return
    const trace = one as Record<string, unknown>
    if (index === 0 && typeof trace.type === 'string') kind = trace.type
    // A trace's length is the length of its longest field: a histogram has
    // only `x`, a heatmap `z`, a scatter both `x` and `y` of the same length.
    let longest = 0
    for (const key of ['x', 'y', 'z', 'values', 'labels', 'lat', 'lon']) {
      longest = Math.max(longest, fieldLength(trace[key]))
    }
    points += longest
  })
  return { kind, traces: figure.data.length, points }
}

/* ----------------------------------------------------- "page ↔ frame" protocol */

/**
 * The protocol tag.
 *
 * A sandbox's origin is the string `"null"`, and checking it is pointless:
 * every other sandbox on the page has the same one. It is the SOURCE that is
 * checked (`event.source === iframe.contentWindow` on the page,
 * `=== window.parent` in the frame), and the tag filters out foreign messages
 * from libraries, extensions and devtools that go through the same
 * `window.postMessage`.
 */
export const PLOTLY_MSG = 'colloq.plotly.v1'

/** The frame is ready to take a figure: the bundle is loaded, the DOM is in place. */
export interface PlotlyReady {
  colloq: typeof PLOTLY_MSG
  kind: 'ready'
}

/** The figure — the only thing that travels inside. */
export interface PlotlyDraw {
  colloq: typeof PLOTLY_MSG
  kind: 'draw'
  figure: PlotlyFigure
}

/** How much space the chart actually took. */
export interface PlotlyHeight {
  colloq: typeof PLOTLY_MSG
  kind: 'height'
  height: number
}

/** It did not draw — and why. An empty space here is worse than any line of text. */
export interface PlotlyFailed {
  colloq: typeof PLOTLY_MSG
  kind: 'failed'
  reason: string
}

export type PlotlyToFrame = PlotlyDraw
export type PlotlyFromFrame = PlotlyReady | PlotlyHeight | PlotlyFailed

/** Whether this looks like our message at all. Both sides check the shape. */
export function isPlotlyMessage(value: unknown): value is { colloq: string; kind: string } {
  if (!value || typeof value !== 'object') return false
  const msg = value as { colloq?: unknown; kind?: unknown }
  return msg.colloq === PLOTLY_MSG && typeof msg.kind === 'string'
}
