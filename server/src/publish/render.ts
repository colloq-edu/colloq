import { tr, getLocale, formatNumber } from '@shared/i18n'
/**
 * A published seminar as a set of plain files.
 *
 * The page all of this was done for has to work on Wednesday evening, when
 * the teacher's laptop is closed. While it is served by the same process that
 * runs the classes, "always available" means "while it is on", that is, it
 * means nothing.
 *
 * So the publication is exported as static files: a directory per course, a
 * directory per step, each with a plain `index.html` holding all the content.
 * No API requests, no client-side routing, no JavaScript at all: such a file
 * will open ten years from now, from an archive, from a USB stick.
 *
 * The price is fair and has to be named: this is a SECOND notebook renderer,
 * next to the room's Svelte components. They can diverge, and one day they
 * will. Keeping one would only be possible with Svelte server-side rendering,
 * and that is build machinery for a page that never changes after export. For
 * a frozen object a separate simple renderer is the right trade-off;
 * `tests/render.test.mts` keeps an eye on it.
 */
import { BLOB_PREFIX, ROBOTS_TAG, type PublicCell, type PublicCourseView } from '@shared/publish'
import { PLOTLY_MIME } from '@shared/plotly'
import { plural } from '@shared/plural'
import { safeStyle } from '@shared/note-css'
import type { CellOutput } from '@shared/notebook'

/**
 * Text without control sequences.
 *
 * The kernel prints color as is, and in the room ansi_up paints it. There are
 * no scripts here at all, so the choice is simple: either strip the escape
 * sequences or leave the student `[0;31m` in the middle of a traceback, and
 * IPython always colors tracebacks. The same set as in the room
 * (web/src/lib/ansi.ts).
 */
// eslint-disable-next-line no-control-regex -- escape codes are the very subject here
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

const plain = (value: string): string => value.replace(ANSI, '')

/** Escaping for text that goes into HTML. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The markup of a note cell.
 *
 * A deliberately tiny subset of markdown: headings, fenced code, both kinds of
 * lists, italics, bold, inline code, links, paragraphs. Pulling in full
 * markdown with a sanitizer means the same weight as in the app, for a page
 * without a single script. Whatever the subset does not know stays text:
 * syntax that was not understood is visible but harmless.
 *
 * HTML, however, is not "what the subset does not know" and must not stay
 * text. The whole note used to go into `esc()`, so a `<div style="…">` inset
 * from a course notebook reached the student as printed tags, while in the
 * room the same cell was rendered. Now the markup goes through the same tag
 * whitelist as kernel output (`htmlSubset`), only wider, and through the same
 * property whitelist as in the room (shared/note-css.ts).
 *
 * Fenced code is parsed first, and not for looks: inside a course example the
 * line `# compute the mean` is a comment, not a heading, and `- x` is a
 * subtraction, not a list item. While there was no fence handling here, the
 * most common construct of a course notebook read on the page as mush: a big
 * heading in the middle of an example and code torn into paragraphs at blank
 * lines.
 */
function markdown(source: string, depth = 1): string {
  /** The path to the publication root: a note image lives next to the step page. */
  const up = '../'.repeat(Math.max(0, depth - 1))
  const inline = (text: string): string =>
    esc(text)
      /*
       * A NOTE image comes from the publication's records, not as a base64
       * string.
       *
       * In the room it lives on the shelf (shared/images.ts); when the page is
       * built it is copied into the publication's records
       * (publish/build.ts · projectNote) and gets the address
       * `blob:<hash>.<ext>`. The rule comes BEFORE the others: without it
       * `![diagram](blob:…)` went into `esc` and was printed on the page as
       * text.
       */
      .replace(
        /!\[([^\]]*)\]\(blob:([0-9a-f]{8,64})\.([a-z0-9]+)\)/gi,
        (_all, alt: string, hash: string, ext: string) =>
          `<img class="note-img" src="${up}blob/${hash}.${ext}" alt="${alt.trim()}">`,
      )
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      /*
       * An image as a link, not `<img src="https://…">`: the page has to open
       * from an archive and from a USB stick, and an external address will one
       * day fail to load and leave a broken frame in its place. Without this
       * rule `![diagram](url)` reached the student as a "!" with a link.
       */
      .replace(
        /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g,
        (_all, alt: string, href: string) =>
          `<a href="${href}" rel="noreferrer">${alt.trim() || tr("server.image.49cd3c")}</a>`,
      )
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')

  const policy = noteHtml(up)
  /*
   * The stack of unclosed tags is one per note, not one per chunk of markup.
   *
   * `<div align="center">`, a blank line, `# Heading`, a blank line, `</div>`
   * is the most common way to center a heading in a notebook, and the blank
   * lines cut it into THREE chunks. Close each chunk on its own and the div
   * would collapse empty, with the heading next to it rather than inside.
   */
  const open: string[] = []
  /** Block markup: tags pile up in the shared stack and survive a blank line. */
  const blockHtml = (markup: string): string => htmlSubset(markup, policy, esc, open)
  /*
   * Markup INSIDE a line has its own stack, and that is no small matter: a
   * paragraph has a `</p>`, and an unclosed `<b>` has to close before it
   * rather than live on to the end of the note. Otherwise it is
   * `<p><b>text</p>…</b>`, and everything else turns bold.
   */
  const lineHtml = (markup: string): string => htmlSubset(markup, policy, inline)

  const out: string[] = []
  let bullets: string[] = []
  let numbers: string[] = []
  /** Lines inside a ``` fence. `null` means there is no fence right now. */
  let fenced: string[] | null = null
  /** Lines of a markup block. `null` means no block right now; a blank line ends the block. */
  let block: string[] | null = null

  const flush = (): void => {
    if (bullets.length > 0) {
      out.push(`<ul>${bullets.map((li) => `<li>${lineHtml(li)}</li>`).join('')}</ul>`)
      bullets = []
    }
    if (numbers.length > 0) {
      out.push(`<ol>${numbers.map((li) => `<li>${lineHtml(li)}</li>`).join('')}</ol>`)
      numbers = []
    }
  }
  const closeFence = (): void => {
    if (fenced === null) return
    out.push(`<pre class="code">${esc(fenced.join('\n'))}</pre>`)
    fenced = null
  }
  /*
   * There is no inline markdown inside a markup block, just as with marked in
   * the room and in CommonMark. `**bold**` inside a `<div>` stays asterisks,
   * and that is not an oversight: an author who wrote a tag does the layout
   * themselves.
   */
  const closeBlock = (): void => {
    if (block === null) return
    out.push(blockHtml(block.join('\n')))
    block = null
  }

  for (const line of source.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (fenced === null) {
        flush()
        // The language after the fence ("```python") is a hint for highlighting,
        // which does not exist here; it has no business on the page as text.
        fenced = []
      } else {
        closeFence()
      }
      continue
    }
    if (fenced !== null) {
      fenced.push(line)
      continue
    }
    if (block === null) {
      const opens = /^\s{0,3}<\/?([a-zA-Z][a-zA-Z0-9]*)/.exec(line)
      if (opens && NOTE_BLOCKS.has(opens[1].toLowerCase())) {
        flush()
        block = []
      }
    }
    if (block !== null) {
      if (line.trim() === '') closeBlock()
      else block.push(line)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const number = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const level = Math.min(heading[1].length + 1, 5)
      out.push(`<h${level}>${lineHtml(heading[2])}</h${level}>`)
    } else if (bullet) {
      if (numbers.length > 0) flush()
      bullets.push(bullet[1])
    } else if (number) {
      if (bullets.length > 0) flush()
      numbers.push(number[1])
    } else if (line.trim() === '') {
      flush()
    } else {
      flush()
      out.push(`<p>${lineHtml(line)}</p>`)
    }
  }
  flush()
  // A fence someone forgot to close: the rest of the note is code anyway, and
  // losing it silently is worse than showing an extra block.
  closeFence()
  closeBlock()
  // An unclosed `<div>` from the note is closed here and goes no further than
  // `.note`: otherwise it would drag the whole page's layout along with it.
  while (open.length > 0) out.push(`</${open.pop()!}>`)
  return out.join('\n')
}

/** The address of a large piece of output inside the exported directory. */
function blobHref(value: string, mime: string): string {
  const hash = value.slice(BLOB_PREFIX.length)
  const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'
  return `blob/${hash}.${ext}`
}

/**
 * A traceback without what is already written above it.
 *
 * IPython opens it with the line "Ename Traceback (most recent call last)"
 * and closes it with "Ename: evalue", and both already stand as the heading
 * above. The room strips the same (web/src/lib/traceback.ts); without this the
 * page reads one error three times. Only an exact repeat is stripped: guessing
 * what is superfluous here is a way to remove the only useful line.
 */
const BANNER = /Traceback \(most recent call last\)/
function tracebackBody(lines: string[], ename: string, evalue: string): string {
  const kept = lines.map(plain)
  const bare = (line: string): string => line.trim()
  const rule = /^[-─—]{3,}$/
  if (kept.length > 1 && rule.test(bare(kept[0])) && BANNER.test(bare(kept[1]))) kept.shift()
  if (kept.length > 0 && bare(kept[0]).startsWith(ename) && BANNER.test(bare(kept[0]))) kept.shift()
  const dropBlanks = (): void => {
    while (kept.length > 0 && bare(kept[kept.length - 1]) === '') kept.pop()
  }
  dropBlanks()
  // `KeyboardInterrupt: `: an error without a value still ends with a colon.
  const echoes = evalue ? [`${ename}: ${evalue}`] : [ename, `${ename}:`]
  if (kept.length > 0 && echoes.includes(bare(kept[kept.length - 1]))) kept.pop()
  dropBlanks()
  return kept.join('\n')
}

/**
 * Output that has only text/html: a pandas table, `display(HTML(...))`.
 *
 * Such output used to vanish from the page without a trace: nothing under the
 * code and "Out [7]" in the footer, and the student read it as "the code
 * printed nothing". `df.style`, `IPython.display.HTML`, plotly, ipywidgets all
 * emit text/html, and the room shows it.
 *
 * What is shown is a SUBSET assembled by whitelist, not someone else's markup
 * as is. Here it comes from cell output, that is, from anyone who ran code in
 * the room, and it lives in a file that will be opened without any server:
 * `<script>` and `<style>` are thrown out along with their content (a style
 * from output would repaint the whole page), other unknown tags are stripped
 * while the text inside them stays. Unclosed tags are closed right here,
 * otherwise one `<div>` from the output would drag the whole page's layout
 * along with it.
 */
const HTML_TAGS: ReadonlySet<string> = new Set(
  `table thead tbody tfoot tr td th caption colgroup col
   p div span br hr blockquote pre code
   b strong i em u s sub sup small
   ul ol li dl dt dd h1 h2 h3 h4 h5 h6 a`
    .trim()
    .split(/\s+/),
)

/** Tags without content: there is nothing to close them with, and no need. */
const HTML_VOID: ReadonlySet<string> = new Set(['br', 'hr', 'col', 'img'])

/** What is allowed on a tag in kernel OUTPUT. Everything else goes, style and class included. */
const HTML_ATTRS: Record<string, ReadonlySet<string>> = {
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  a: new Set(['href']),
}

/**
 * A tag set and an attribute rule, as one object.
 *
 * There is one parser below but two sets, and they differ for a reason: cell
 * output is the repr of `df.style` and a pandas table, where the styling
 * arrives as a separate `<style>` and is therefore stripped entirely; a note
 * is text a person wrote by hand, and `style` in it is the very point.
 */
interface HtmlPolicy {
  tags: ReadonlySet<string>
  /** The attribute value as it should be written, or `null` for "do not write". */
  attr: (tag: string, name: string, value: string) => string | null
}

const OUTPUT_HTML: HtmlPolicy = {
  tags: HTML_TAGS,
  attr(tag, name, value) {
    if (!HTML_ATTRS[tag]?.has(name)) return null
    // Only http(s) addresses: a `javascript:` link from cell output would
    // execute for whoever opened the page.
    if (name === 'href') return /^https?:\/\//i.test(value) ? value : null
    return /^\d{1,3}$|^(row|col|rowgroup|colgroup)$/.test(value) ? value : null
  },
}

/**
 * The tags a NOTE may bring.
 *
 * Wider than for output, and exactly as much wider as the subject itself: a
 * note is written as markup, not received as a repr. `img`, `details`,
 * `figure`, `font`, `center` are what an ordinary text cell of a course
 * notebook is made of, and without them "HTML does not work" would be half
 * true.
 *
 * `style`, `script`, `iframe`, `form`, `audio`, `video` are not included and
 * will not be: the same list as in the room (web/src/lib/sanitize.ts); the
 * "same cells" promise is kept by identical prohibitions, not similar ones.
 */
const NOTE_TAGS: ReadonlySet<string> = new Set([
  ...HTML_TAGS,
  ...`img figure figcaption details summary mark kbd abbr samp var q cite time
      ins del big tt center font
      section article aside header footer nav main`
    .trim()
    .split(/\s+/),
])

/**
 * A note's block tags: a line starting with one begins markup, not a
 * paragraph.
 *
 * Without this list a multi-line `<div>` would be cut into lines and each
 * wrapped in `<p>`: the browser fixes `<p><div …></p>` its own way, and the
 * inset falls apart. The end-of-block rule is a blank line, as in CommonMark
 * and with marked in the room; it is also what makes `<div align="center">`,
 * a blank line, `# Heading`, a blank line, `</div>` work.
 */
const NOTE_BLOCKS: ReadonlySet<string> = new Set(
  `div p table thead tbody tfoot tr td th caption colgroup col
   ul ol li dl dt dd blockquote pre hr
   h1 h2 h3 h4 h5 h6
   figure figcaption details summary center
   section article aside header footer nav main`
    .trim()
    .split(/\s+/),
)

/**
 * The address of a note image on the exported page.
 *
 * `blob:<hash>.<ext>` is a publication record next to the step page
 * (build.ts · projectNote), the same path as for `![diagram](blob:…)` in
 * `inline`. An external `https://` stays as written: for a markdown image the
 * renderer is free to choose the representation and makes a link of it, but a
 * raw `<img>` was put there by a person who counted on it in the layout;
 * replacing it with a link means silently breaking someone else's layout.
 */
function noteImageSrc(value: string, up: string): string | null {
  const blob = /^blob:([0-9a-f]{8,64})\.([a-z0-9]+)$/i.exec(value)
  if (blob) return `${up}blob/${blob[1]}.${blob[2]}`
  if (/^https?:\/\//i.test(value)) return value
  if (/^data:image\/(png|jpeg|gif|webp|svg\+xml);/i.test(value)) return value
  return null
}

function noteHtml(up: string): HtmlPolicy {
  return {
    tags: NOTE_TAGS,
    attr(tag, name, value) {
      // Styling goes through the same property whitelist as in the room.
      if (name === 'style') return safeStyle(value) || null
      if (name === 'title' || name === 'alt') return value
      if (name === 'align') return /^(left|right|center|justify)$/i.test(value) ? value : null
      if (name === 'width' || name === 'height') return /^\d{1,4}$/.test(value) ? value : null
      if (name === 'colspan' || name === 'rowspan' || name === 'span')
        return /^\d{1,3}$/.test(value) ? value : null
      if (name === 'scope') return /^(row|col|rowgroup|colgroup)$/i.test(value) ? value : null
      if (name === 'start' && (tag === 'ol' || tag === 'li'))
        return /^\d{1,4}$/.test(value) ? value : null
      if (tag === 'details' && name === 'open') return ''
      if (tag === 'time' && name === 'datetime') return value
      if (tag === 'font' && name === 'color') return /^[#\w(),.%\s-]{1,40}$/.test(value) ? value : null
      if (tag === 'font' && name === 'size') return /^[+-]?\d{1,2}$/.test(value) ? value : null
      if (tag === 'font' && name === 'face') return /^[\w ,'"-]{1,80}$/.test(value) ? value : null
      // A link: http(s), mail and anchors. `javascript:` would execute for
      // whoever opened the page, the same argument as for output above.
      if (tag === 'a' && name === 'href')
        return /^(https?:\/\/|mailto:|#)/i.test(value) ? value : null
      if (tag === 'img' && name === 'src') return noteImageSrc(value, up)
      /*
       * `class` is deliberately not let through. The static page has its own
       * rules (`.code`, `.out`, `.err`, `.quiet`), and a note with
       * `class="err"` would read as an execution error. In the room a class is
       * harmless, because there the note's styling is set by `.prose-note`,
       * not by names from the cell.
       */
      return null
    },
  }
}

function keepAttrs(policy: HtmlPolicy, tag: string, raw: string): string {
  let out = ''
  const pairs = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))|([a-zA-Z-]+)/g
  let found: RegExpExecArray | null
  while ((found = pairs.exec(raw)) !== null) {
    const name = (found[1] ?? found[5] ?? '').toLowerCase()
    if (!name) continue
    const value = found[2] ?? found[3] ?? found[4] ?? ''
    const kept = policy.attr(tag, name, value)
    if (kept === null) continue
    out += kept ? ` ${name}="${esc(kept)}"` : ` ${name}`
  }
  return out
}

/** A tag with its attributes: quotes can hide both "<" and ">" inside. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/y

/**
 * Markup reduced to the policy's subset.
 *
 * `text` says what to do with text OUTSIDE tags. For output it goes as is (the
 * repr is already escaped by the kernel, a second pass would give
 * `&amp;amp;`); for a note, inline markdown goes through it, and only through
 * it: substituting `**bold**` across the whole line would mean writing tags
 * into someone else's attribute.
 *
 * `open` is the stack of unclosed tags. Its own per call if none is given: a
 * lone `<div>` from output would drag the whole page's layout along with it.
 * A note passes here one stack shared by all its chunks, so that a
 * `<div align="center">` before a blank line and a `</div>` after the heading
 * stay one block, as in the room.
 */
function htmlSubset(
  source: string,
  policy: HtmlPolicy = OUTPUT_HTML,
  text: (value: string) => string = (value) => value,
  open?: string[],
): string {
  const stripped = source
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
  const out: string[] = []
  const stack = open ?? []
  let i = 0
  while (i < stripped.length) {
    const lt = stripped.indexOf('<', i)
    if (lt === -1) {
      out.push(text(stripped.slice(i)))
      break
    }
    out.push(text(stripped.slice(i, lt)))
    // A sticky parse from a position, not on a slice of the string: a `slice`
    // per tag would turn a megabyte table into the square of its length.
    TAG.lastIndex = lt
    const tag = TAG.exec(stripped)
    if (!tag) {
      // A lone "<" is text, not the start of a tag.
      out.push('&lt;')
      i = lt + 1
      continue
    }
    i = TAG.lastIndex
    const name = tag[2].toLowerCase()
    if (!policy.tags.has(name)) continue
    if (tag[1]) {
      const at = stack.lastIndexOf(name)
      if (at === -1) continue
      while (stack.length > at) out.push(`</${stack.pop()!}>`)
      continue
    }
    out.push(`<${name}${keepAttrs(policy, name, tag[3])}>`)
    if (!HTML_VOID.has(name) && !/\/\s*$/.test(tag[3])) stack.push(name)
  }
  if (!open) while (stack.length > 0) out.push(`</${stack.pop()!}>`)
  return out.join('')
}

/**
 * Whether the markup has anything to show.
 *
 * The string's length does not tell, and that is no small matter: plotly,
 * bokeh and ipywidgets put an empty `<div id=…>` into text/html next to a
 * `<script>` that draws it in the browser. A script from someone else's output
 * does not get into the page (see `htmlSubset`), and what is left is
 * `<div></div>`: non-empty markup, and nothing under the cell. Trusting a
 * non-empty string means bringing back exactly what all this was written to
 * fix: an empty space captioned "Out [1]" instead of an honest note about a
 * format the page does not know.
 *
 * Visible means text outside tags (`&nbsp;` does not count) and a rule, which
 * is visible by itself. An empty table does not count as content: a grid of
 * borders without a single number reads as a broken page, and a note does
 * not.
 */
function hasVisible(html: string): boolean {
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#0*160;|&#x0*a0;/gi, ' ')
  return /\S/.test(text) || /<hr\b/i.test(html)
}

function outputHtml(output: CellOutput, depth: number): string {
  /*
   * Images live at the publication root, next to the first step. The first
   * step is that root itself (depth 1), the others one level deeper, so we
   * have to go up `depth - 1`, not `depth`: an extra `../` would lead to a
   * neighboring publication, and the image would be missing on exactly the
   * page that is opened first.
   */
  const up = '../'.repeat(depth - 1)
  if (output.kind === 'stream') {
    return `<pre class="out ${output.name === 'stderr' ? 'err' : ''}">${esc(plain(output.text))}</pre>`
  }
  if (output.kind === 'error') {
    const head = output.ename + (output.evalue ? ': ' + output.evalue : '')
    const body = tracebackBody(output.traceback, output.ename, output.evalue)
    return `<pre class="out err">${esc([plain(head), body].filter(Boolean).join('\n\n'))}</pre>`
  }
  /*
   * An interactive chart, and an honest line in its place.
   *
   * The exported directory lives on static hosting: there is no server behind
   * it, and the frame plotly draws in is a response with a special header
   * (`server/src/plotly-frame.ts`), which nobody there can serve. Drawing the
   * figure right in the page is even less acceptable: it is someone else's
   * data and five megabytes of someone else's code on an origin that holds
   * other classes too.
   *
   * So a line rather than an empty space: "Out [7]" with nothing under it
   * reads as "the code printed nothing", and that is a lie. The instance's
   * live reader shows the same chart in full, and the line says so.
   */
  if (output.data[PLOTLY_MIME] !== undefined) {
    return `<p class="quiet">${esc(tr('server.ssr.plotlyFigure'))}</p>`
  }
  const image = Object.entries(output.data).find(([mime]) => mime.startsWith('image/'))
  if (image) {
    const [mime, value] = image
    /*
     * SVG comes from the kernel as XML text, not base64, and does not move
     * into a separate record (see BLOB_MIMES): `data:image/svg+xml;base64,<xml>`
     * gave an empty frame. As an image, not as markup right in the page: inside
     * `<img>` a script from someone else's output does not execute.
     */
    const src = value.startsWith(BLOB_PREFIX)
      ? up + blobHref(value, mime)
      : mime === 'image/svg+xml'
        ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`
        : `data:${mime};base64,${value.replace(/\s/g, '')}`
    return `<p class="img"><img src="${esc(src)}" alt="${esc(tr('server.ssr.cellOutput'))}"></p>`
  }
  /*
   * text/html comes before text/plain, and not as a matter of taste: for
   * `df.style` text/plain holds
   * "<pandas.io.formats.style.Styler object at 0x…>", exactly what the
   * student should see a table instead of.
   */
  const rich = output.data['text/html']
  if (rich) {
    const safe = htmlSubset(rich).trim()
    if (hasVisible(safe)) return `<div class="rich">${safe}</div>`
  }
  /*
   * `display(Markdown(...))` is a caption to the output in words, and on the
   * page it has to be words.
   *
   * The kernel sends two representations: the markup itself and `text/plain`
   * with the repr `<IPython.core.display.Markdown object>`. Before this branch
   * existed the page printed the class name, exactly what the room did before
   * `text/markdown` was added to `MIME_ORDER`
   * (web/src/components/notebook/output-mimes.ts).
   *
   * It is parsed with the same subset as a note: `markdown` above already
   * handles both the tag whitelist and the property whitelist, so kernel
   * output and a person's text pass the same check here.
   */
  const note = output.data['text/markdown']
  if (note) {
    const body = markdown(plain(note), depth).trim()
    if (hasVisible(body)) return `<div class="note">${body}</div>`
  }
  const text = output.data['text/plain']
  if (text) return `<pre class="out">${esc(plain(text))}</pre>`
  /*
   * Nothing to show it with, but it has to be said. An empty space under a
   * cell captioned "Out [7]" reads as "the code printed nothing", and that is
   * a lie: there was output, just in a format the static page does not know.
   */
  const kinds = Object.keys(output.data)
  return kinds.length > 0
    ? `<p class="quiet">${esc(tr('server.ssr.unsupportedOutput', { format: kinds.join(', ') }))}</p>`
    : ''
}

function cellHtml(cell: PublicCell, depth: number): string {
  if (cell.type === 'markdown') return `<div class="note">${markdown(cell.source, depth)}</div>`
  const outputs = cell.outputs.map((o) => outputHtml(o, depth)).join('\n')
  /*
   * `Out [—]`: there is output, but no execution behind it any more: the
   * kernel was restarted or a version restored. Staying silent is more honest
   * than putting in a number.
   */
  const stamp =
    cell.execCount === null
      ? cell.outputs.length > 0
        ? '<span class="warn">Out [—]</span>'
        : `<span class="quiet">${esc(tr('server.ssr.notRun'))}</span>`
      : `Out [${cell.execCount}]${cell.ranMs !== null ? ` · ${formatNumber(cell.ranMs / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}s` : ''}`
  return [
    '<div class="cell">',
    `<pre class="code">${esc(cell.source)}</pre>`,
    outputs ? `<div class="outs">${outputs}</div>` : '',
    `<div class="foot">${stamp}</div>`,
    '</div>',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Styling.
 *
 * In one piece inside the file: the page has to open on its own, and a
 * separate .css is a second request that will one day fail to arrive, and the
 * text will fall apart. The colors and fonts are the same as in the room.
 */
const STYLE = `
:root{--ink:#101A33;--muted:#5D6B8A;--faint:#9BA6BE;--line:#DCE3EF;--surface:#F3F6FB;--accent:#0B7FAB;--warn:#8E6B00;--err:#8E2334;--bg:#fff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent)}
.wrap{max-width:820px;margin:0 auto;padding:56px 20px 80px}
h1{font-size:38px;line-height:1.1;letter-spacing:-.02em;margin:0 0 12px}
.blurb{font-size:16px;color:var(--muted);margin:0 0 14px;max-width:36em}
.addr{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);margin:0 0 40px}
.rows{border-top:1px solid var(--line);margin:0;padding:0;list-style:none}
.row{display:flex;align-items:baseline;gap:20px;border-bottom:1px solid var(--line);padding:18px 0}
.row .n{width:34px;flex:0 0 auto;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint)}
.row .t{flex:1 1 auto;font-size:17px;font-weight:600;min-width:0}
.row .s{flex:0 0 auto;color:var(--muted);font-size:14px;white-space:nowrap}
.row.off .t{font-weight:400;color:var(--muted)}
.row.off .s{white-space:normal;max-width:45%;overflow-wrap:break-word;text-align:right}
.row a{text-decoration:none;color:inherit;display:flex;align-items:baseline;gap:20px;width:100%}
.row a:hover .t{color:var(--accent)}
.foot-note{color:var(--muted);font-size:14px;margin-top:34px}
header.top{border-bottom:1px solid var(--line);padding:36px 20px 22px}
header.top .in{max-width:1180px;margin:0 auto}
header.top h1{font-size:32px;margin:0 0 8px}
.meta{color:var(--muted);font-size:14px;margin:0}
.body{max-width:1180px;margin:0 auto;padding:0 20px;display:flex;gap:36px;align-items:flex-start}
.rail{width:250px;flex:0 0 auto;padding:26px 0;border-right:1px solid var(--line);position:sticky;top:0}
.rail h2{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
.rail a{display:block;text-decoration:none;color:var(--muted);border-left:3px solid transparent;padding:7px 12px 7px 11px;margin-right:18px}
.rail a.on{border-left-color:var(--accent);background:var(--surface);color:var(--ink);font-weight:600}
.rail .w{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--faint);display:block;margin-top:2px;font-weight:400}
.main{flex:1 1 auto;min-width:0;padding:26px 0 70px;max-width:820px}
.intro{background:var(--surface);border-left:3px solid var(--accent);padding:13px 16px;margin:0 0 30px}
.intro p{margin:0 0 5px;color:var(--muted);font-size:14px}
.intro p:last-child{margin:0}
.note{margin:0 0 22px}
.note h2{font-size:22px;margin:0 0 8px}.note h3{font-size:18px;margin:0 0 6px}
.note p{margin:0 0 8px}
.note:after{content:'';display:table;clear:both}
.note ul,.note ol{margin:0 0 8px;padding-left:22px}
.note blockquote{margin:0 0 8px;padding-left:12px;border-left:2px solid var(--line);color:var(--muted)}
.note img{max-width:100%;height:auto}
.note table{border-collapse:collapse;margin:0 0 10px}
.note th,.note td{border:1px solid var(--line);padding:4px 9px;text-align:left}
.note details{margin:0 0 8px}.note summary{cursor:pointer;color:var(--muted)}
.note code{background:var(--surface);padding:1px 4px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.note [style]{max-width:100%}
.note [style*="background"]{color:#1B2233}
.cell{border:1px solid var(--line);margin:0 0 22px}
.code{margin:0;padding:13px 15px;background:#FBFCFE;overflow-x:auto;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre}
.outs{border-top:1px solid var(--line);padding:11px 15px}
.out{margin:0;overflow-x:auto;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.out.err{color:var(--err)}
.rich{overflow-x:auto;font-size:14px}
.rich table{border-collapse:collapse;font-size:13px;margin:0}
.rich th,.rich td{border:1px solid var(--line);padding:5px 9px;text-align:right;white-space:nowrap}
.rich th{color:var(--muted);font-weight:600}
.rich p{margin:0 0 6px}.rich p:last-child{margin:0}
.quiet{color:var(--faint);margin:0}
.img{margin:0}.img img{max-width:100%;height:auto;display:block}
.note-img{max-width:100%;height:auto;display:block;margin:10px 0}
.foot{border-top:1px solid var(--line);background:#FBFCFE;padding:6px 15px;text-align:right;font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.foot .warn{color:var(--warn)}.foot .quiet{color:var(--faint)}
.take{border-top:1px solid var(--line);margin-top:34px;padding-top:18px;font-size:14px}
.take p{margin:0}
.take .why{color:var(--muted);margin-top:5px}
@media(max-width:860px){.body{display:block}.rail{width:auto;border-right:0;border-bottom:1px solid var(--line);position:static;padding:20px 0}.rail a{margin-right:0}}
@media(prefers-color-scheme:dark){:root{--ink:#E8EDF7;--muted:#9AA7C0;--faint:#6B7897;--line:#26304A;--surface:#161E33;--accent:#4FC3F0;--warn:#E0B44A;--err:#F0868E;--bg:#0D1526}.code,.foot{background:#111A2E}}
`

/**
 * The document head.
 *
 * `robots` comes from the shared decision (shared/publish.ts), not from an
 * opinion of our own: the instance serves the same pages at its own
 * addresses, and while the rule stood as a comment on both sides, the sides
 * managed to diverge.
 */
function head(title: string): string {
  return [
    `<!doctype html><html lang="${getLocale()}"><head>`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="robots" content="${ROBOTS_TAG}">`,
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
  ].join('')
}

const FOOT = '</body></html>'

export interface RenderedStep {
  seq: number
  label: string
  at: number
  cells: PublicCell[]
}

/*
 * The page's time zone is set explicitly, not taken from the process.
 *
 * The export runs on the server, not in the lecture hall: in a container and
 * on an ordinary VPS no zone is set at all, that is, UTC, and a class held in
 * Moscow at 15:04 was captioned "12:04" by the page. With such a caption you
 * cannot find which lesson it was, and there is nothing to check it against
 * on a static page: in the room the browser draws the time, here there is
 * nobody to draw it.
 *
 * The instance's zone is `TZ`, and it is read on every formatting call rather
 * than once at module load: it arrives from `.env` through dotenv in
 * config.ts, and this module loads before that. For the same reason the zone
 * is passed as an option: a variable read after startup may no longer become
 * the process's zone.
 */
const HOME_ZONE = 'Europe/Moscow'
const DATE_FORM: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }
const TIME_FORM: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

function formatter(form: Intl.DateTimeFormatOptions, zone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(getLocale(), { ...form, timeZone: zone })
  } catch {
    // `TZ=MSK` and other names missing from the time zone database: a typo in
    // .env must not bring down the whole export.
    return new Intl.DateTimeFormat(getLocale(), { ...form, timeZone: HOME_ZONE })
  }
}

let clocks: { locale: string; zone: string; date: Intl.DateTimeFormat; time: Intl.DateTimeFormat } | null = null

function forms(): { date: Intl.DateTimeFormat; time: Intl.DateTimeFormat } {
  const zone = process.env.TZ?.trim() || HOME_ZONE
  if (!clocks || clocks.zone !== zone || clocks.locale !== getLocale()) {
    clocks = { locale: getLocale(), zone, date: formatter(DATE_FORM, zone), time: formatter(TIME_FORM, zone) }
  }
  return clocks
}

const when = (at: number): string => forms().date.format(at)
const clock = (at: number): string => forms().time.format(at)

/** The course page. */
export function renderCourse(course: PublicCourseView, base: string): string {
  const rows = course.items
    .map((item, index) => {
      const n = String(index + 1).padStart(2, '0')
      if (item.kind === 'gone') {
        /*
         * The room is gone but the reading remains: that is the default when a
         * seminar is deleted, and without a link the row would be a dead end:
         * the page is alive, but it cannot be reached from the course, the only
         * address the class is given.
         */
        if (!item.publication) {
          return `<li class="row off"><span class="n">${n}</span><span class="t">${esc(item.name)}</span><span class="s">${esc(tr('server.ssr.seminarDeleted'))}</span></li>`
        }
        const gone = `${base}/p/${item.publication.slug ?? item.publication.id}/`
        return [
          '<li class="row">',
          `<a href="${esc(gone)}">`,
          `<span class="n">${n}</span>`,
          `<span class="t">${esc(item.name)}</span>`,
          `<span class="s">${esc(tr('server.ssr.deletedReadable'))}</span>`,
          '</a></li>',
        ].join('')
      }
      if (item.kind === 'planned') {
        // The week is typed by hand in the panel, up to forty characters: with
        // `nowrap` on a phone it took the whole row and lay over the topic.
        // Hence `.row.off .s` in STYLE: wrapping and no more than 45% width.
        return `<li class="row off"><span class="n">${n}</span><span class="t">${esc(item.name)}</span><span class="s">${esc(item.when)}</span></li>`
      }
      if (!item.publication) {
        return `<li class="row off"><span class="n">${n}</span><span class="t">${esc(item.name)}</span><span class="s">${esc(tr('server.ssr.unpublished'))}</span></li>`
      }
      const href = `${base}/p/${item.publication.slug ?? item.publication.id}/`
      const steps =
        item.publication.steps === 1
          ? tr("server.onePage.d5f549")
          : tr('server.steps', { count: item.publication.steps })
      return [
        '<li class="row">',
        `<a href="${esc(href)}">`,
        `<span class="n">${n}</span>`,
        `<span class="t">${esc(item.name)}</span>`,
        `<span class="s">${esc(when(item.publication.publishedAt))} · ${steps}</span>`,
        '</a></li>',
      ].join('')
    })
    .join('\n')

  return [
    head(course.name),
    '<div class="wrap">',
    `<h1>${esc(course.name)}</h1>`,
    course.blurb ? `<p class="blurb">${esc(course.blurb)}</p>` : '',
    `<p class="addr">${esc(base.replace(/^https?:\/\//, ''))}/c/${esc(course.slug ?? course.id)}</p>`,
    `<ul class="rows">${rows}</ul>`,
    `<p class="foot-note">${esc(tr('server.ssr.courseAbout'))}</p>`,
    '</div>',
    FOOT,
  ].join('\n')
}

/**
 * A pointer page from an old address to the current one.
 *
 * A course or publication was given a name, and the directory now lives
 * under it, while a link handed to the class with the eight-character id must
 * keep working. On the live server `WHERE id = ? OR slug = ?` does it; Pages
 * has no routing at all, so the old address stays as a file that forwards to
 * the new one. The link at the bottom is for when `refresh` is disabled.
 */
export function renderRedirect(to: string, title: string): string {
  return [
    `<!doctype html><html lang="${getLocale()}"><head>`,
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<meta name="robots" content="${ROBOTS_TAG}">`,
    `<meta http-equiv="refresh" content="0; url=${esc(to)}">`,
    `<link rel="canonical" href="${esc(to)}">`,
    `<title>${esc(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
    '<div class="wrap">',
    `<p class="blurb">${esc(tr('server.ssr.moved'))} <a href="${esc(to)}">${esc(to)}</a></p>`,
    '</div>',
    FOOT,
  ].join('\n')
}

/**
 * The tombstone of a withdrawn page.
 *
 * The promise is written in store.ts in so many words: "Withdrawing a page
 * does not cancel its address: the link must say 'it was withdrawn', not
 * 'there is no such page here'". On the live server it was so, while on
 * Pages, the very "for Wednesday evening" medium, the directory was simply
 * wiped, and a link from the group chat answered with GitHub's standard 404.
 * From it a student cannot tell a withdrawn page from a typo in the address
 * and goes to ask "is that really the right link?".
 *
 * There are no steps and no images here: a withdrawn page must not be
 * readable around the teacher's decision; it has to speak for itself.
 */
export function renderWithdrawn(
  title: string,
  course: { name: string; handle: string } | null,
  base: string,
): string {
  return [
    head(title),
    '<div class="wrap">',
    `<h1>${esc(title)}</h1>`,
    `<p class="blurb">${esc(tr('server.ssr.withdrawn'))}</p>`,
    course
      ? `<p class="foot-note">${esc(tr('server.ssr.otherClasses'))} <a href="${esc(base)}/c/${esc(course.handle)}/">${esc(course.name)}</a></p>`
      : '',
    '</div>',
    FOOT,
  ]
    .filter(Boolean)
    .join('\n')
}

export interface SeminarPage {
  title: string
  publishedAt: number
  course: { name: string; handle: string } | null
  steps: { seq: number; label: string; at: number; cellCount: number }[]
  step: RenderedStep
  /** Depth relative to the publication root: 1 for the first step, 2 for the others. */
  depth: number
  base: string
}

/** The page of one step. */
export function renderStep(page: SeminarPage): string {
  const many = page.steps.length > 1
  const up = page.depth === 1 ? '' : '../'
  /*
   * Each step has its own notebook, and it lives in the step's directory
   * (export.ts). There used to be one link for all steps, serving the last: a
   * reader comparing "before" and "after" on step 2 of 5 (exactly the one for
   * whom the step lives in the address) took away the state of step 5 and
   * found out only on opening the file. In the room this is already fixed
   * (`?step=`), while the static export kept the old promise.
   *
   * `p/<handle>/notebook.ipynb` meanwhile stays the last step's notebook:
   * links handed out earlier point to it, and what they download must not
   * change. That is why even the first step, whose page is lifted to the
   * publication root, links down into its own directory.
   */
  const notebook = page.depth === 1 ? `${page.step.seq}/notebook.ipynb` : 'notebook.ipynb'
  /*
   * The caption is word for word the same as in the reader
   * (ReaderScreen.svelte): the file is meant as "code to run on your own
   * machine", and what it lacks is said next to the link rather than
   * discovered after the download.
   */
  const about = !many
    ? tr("server.codeWithoutOutputs.e86524")
    : page.steps.at(-1)?.seq === page.step.seq
      ? tr("server.codeFromTheLastStepWithoutOutputs.84324c")
      : tr("server.codeFromThisStepWithoutOutputs.e310ab")
  const rail = many
    ? [
        `<nav class="rail"><h2>${esc(tr('server.ssr.stepsHeading'))}</h2>`,
        ...page.steps.map((s, i) => {
          const on = s.seq === page.step.seq
          // `./`, not an empty string: an empty href means "the whole current
          // URL", query string included, and in an archive such a link behaves
          // oddly.
          const href = i === 0 ? `${up || './'}` : `${up}${s.seq}/`
          return `<a class="${on ? 'on' : ''}" href="${esc(href)}">${esc(s.label)}<span class="w">${clock(s.at)} · ${s.cellCount}</span></a>`
        }),
        '</nav>',
      ].join('\n')
    : ''

  return [
    head(page.title),
    '<header class="top"><div class="in">',
    `<h1>${esc(page.title)}</h1>`,
    '<p class="meta">',
    page.course
      ? `<a href="${esc(page.base)}/c/${esc(page.course.handle)}/">${esc(page.course.name)}</a> · `
      : '',
    tr("server.published.e49f01", { p0: esc(when(page.publishedAt)) }),
    many ? ` · ${tr('server.steps', { count: page.steps.length })}` : '',
    '</p></div></header>',
    '<div class="body">',
    rail,
    '<main class="main">',
    '<div class="intro">',
    `<p>${esc(tr('server.ssr.publishedNotebook'))}</p>`,
    many
      ? `<p>${esc(tr('server.ssr.stepOutputs'))}</p>`
      : '',
    `<p>${esc(tr('server.ssr.privacy'))}</p>`,
    '</div>',
    page.step.cells.map((cell) => cellHtml(cell, page.depth)).join('\n'),
    '<div class="take">',
    `<p><a href="${esc(notebook)}" download>${esc(tr('server.ssr.download'))}</a></p>`,
    `<p class="why">${esc(tr('server.ssr.runLocally', { about }))}</p>`,
    '</div>',
    '</main></div>',
    FOOT,
  ]
    .filter(Boolean)
    .join('\n')
}

export { blobHref }
