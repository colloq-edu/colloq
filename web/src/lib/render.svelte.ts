/**
 * marked, DOMPurify and ansi_up exist to render text other people wrote, so
 * nothing needs them until a notebook is on screen. They used to be imported
 * directly by three components, which put 25 KB gzip of markdown and ANSI
 * machinery on the join screen — the one screen thirty students hit at the same
 * moment, on the same wifi, at the start of a seminar.
 *
 * They now arrive as one chunk on first render, and until it lands every caller
 * shows readable plain text instead of nothing.
 *
 * The sanitising policy lives here and only here. Each of the three consumers
 * used to carry its own copy of it; a second copy of a security policy is how a
 * hole gets opened, not how one gets closed.
 */

import { foldAnsiColours, pendingEscape } from './ansi'
import { safeStyle } from '@shared/note-css'
import {
  MARKDOWN_FORBIDDEN_ATTRS,
  MARKDOWN_FORBIDDEN_TAGS,
  noteClasses,
  noteReference,
  OUTPUT_FORBIDDEN_ATTRS,
} from './sanitize'

export { ansi256ToBasic, foldAnsiColours, stripAnsi } from './ansi'

/** What the module exposes once the chunk has landed. */
export interface Renderers {
  /** Untrusted markdown -> sanitized HTML, external links defused. */
  markdown: (source: string, options?: MarkdownOptions) => string
  /** Terminal/stdout text -> sanitized HTML with the ANSI colours kept. */
  ansi: (text: string) => string
  /** Untrusted HTML (a DataFrame repr, a rich output) -> sanitized HTML. */
  html: (markup: string) => string
  /** Untrusted SVG (a matplotlib figure) -> sanitized SVG. */
  svg: (markup: string) => string
}

/** How markdown() shapes its output beyond the sanitizing policy, which never varies. */
export interface MarkdownOptions {
  /**
   * Images get `loading="lazy"`: a public class page can carry dozens of note
   * screenshots, and a phone on campus data should not pull them all at once.
   */
  lazyImages?: boolean
  /**
   * Links become their words and images their alt text: for text that is read
   * and never followed. The speaker notes on the lecture console are the case:
   * a tap on a link there leaves the console mid-lecture, and an image in a
   * note is a request from a tablet in a dark hall for a picture nobody has
   * time to look at.
   */
  inert?: boolean
}

/*
 * Narrowing happens in the .then PARAMETER on purpose. Hand Rollup a whole
 * module namespace — `.then((m) => m.marked)` counts as whole — and it has to
 * assume every export of the package is live, which measured 28 KB of dead
 * CodeMirror when the editor was split the same way.
 */
/*
 * Math in notes — as in Jupyter: `$…$` inside a line, `$$…$$` as a block.
 *
 * Two marked extensions of our own instead of the ready-made
 * marked-katex-extension: that one has to draw the formula at once, while here
 * it must survive the sanitizer (see `markdown` below). The markup gets an
 * empty node that only NAMES the formula; the TeX waits outside the markup,
 * in the render's own list, so neither a quote nor a `<` from it can become
 * markup.
 *
 * Names, and not the TeX itself, because the placeholder is an attribute,
 * and raw HTML in a note brings attributes of its own. The TeX used to travel
 * in `data-math`, URI-encoded, and every `[data-math]` that came out of the
 * sanitizer was taken for ours: `<span data-math="%">` reached
 * decodeURIComponent, whose URIError went out of markdown() and out of
 * Svelte's update with it — on the production build NO note on the page was
 * formatted any more, for anyone, on every load. So a placeholder carries the
 * render's token and a number, the token is drawn afresh for every render,
 * and a `[data-math]` without it is somebody's markup: the attribute goes,
 * the words stay.
 *
 * `$5 and $10` is not a formula: there is never a space right after the
 * opening dollar or right before the closing one, and never a digit right
 * after the closing one. This is Pandoc's rule, and it also saves prices in a
 * task's text.
 */
export interface Formula {
  tex: string
  display: boolean
}

/** The render in progress — marked calls the extensions synchronously, from inside markdown(). */
let rendering: { token: string; formulas: Formula[] } | null = null

function mathSlot(tex: string, display: boolean): string {
  const tag = display ? 'div' : 'span'
  if (!rendering) {
    // A parse outside markdown() has no list to wait in: the formula stays the text it was.
    const text = display ? `$$${tex}$$` : `$${tex}$`
    return `<${tag}>${text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</${tag}>`
  }
  rendering.formulas.push({ tex, display })
  return `<${tag} data-math="${rendering.token}-${rendering.formulas.length - 1}"></${tag}>`
}

/**
 * A token no note can know in advance: drawn per render, never stored.
 *
 * `getRandomValues`, not `randomUUID`: the latter exists only in a secure
 * context, and an instance on a department's plain http is a real one.
 */
function renderToken(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(2)), (word) => word.toString(36)).join('')
}

/**
 * The formula a placeholder names — `undefined` for any `data-math` this
 * render did not write. Exported for tests/markdown-math.test.mts.
 */
export function formulaAt(value: string | null, token: string, formulas: readonly Formula[]): Formula | undefined {
  const number = value?.startsWith(`${token}-`) ? value.slice(token.length + 1) : ''
  return /^\d+$/.test(number) ? formulas[Number(number)] : undefined
}

/**
 * The placeholder's attribute: the only `data-*` a note keeps, because the
 * renderer writes it itself (lib/sanitize.ts · names).
 */
const MATH_SLOT_ATTRS = ['data-math']

const blockMath = {
  name: 'blockMath',
  level: 'block' as const,
  start: (src: string) => src.indexOf('$$'),
  tokenizer(src: string) {
    const match = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src)
    return match ? { type: 'blockMath', raw: match[0], text: match[1].trim() } : undefined
  },
  renderer: (token: { text: string }) => mathSlot(token.text, true),
}

const inlineMath = {
  name: 'inlineMath',
  level: 'inline' as const,
  start: (src: string) => src.indexOf('$'),
  tokenizer(src: string) {
    const match = /^\$\$([^$]+?)\$\$/.exec(src) ?? /^\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$(?!\d)/.exec(src)
    if (!match) return undefined
    const display = match[0].startsWith('$$')
    return { type: display ? 'blockMath' : 'inlineMath', raw: match[0], text: match[1].trim() }
  },
  renderer: (token: { text: string }) => mathSlot(token.text, false),
}

async function importRenderers(): Promise<Renderers> {
  const [{ marked }, { DOMPurify }, { AnsiUp }, { katex }] = await Promise.all([
    import('marked').then(({ marked }) => ({ marked })),
    import('dompurify').then(({ default: DOMPurify }) => ({ DOMPurify })),
    import('ansi_up').then(({ AnsiUp }) => ({ AnsiUp })),
    import('katex').then(({ default: katex }) => ({ katex })),
    // KaTeX's styles together with its fonts — as a separate chunk, only when a
    // notebook is on screen: the other pages need no formulas.
    // @ts-expect-error — css has no types, and only the side effect is needed
    import('katex/dist/katex.min.css'),
  ])
  marked.use({ extensions: [blockMath, inlineMath] })

  const newConverter = () => {
    const converter = new AnsiUp()
    converter.escape_html = true
    /*
     * Classes, not inline colours. ansi_up's own palette puts an error name at
     * 2.79:1 on the dark ground — the least readable thing on screen at the
     * moment it matters most, because a traceback is what you read when
     * something has just broken. The .ansi-* rules in index.css carry a
     * palette measured against both grounds instead.
     */
    converter.use_classes = true
    return converter
  }

  /** An already rendered piece of output and the converter that rendered it. */
  interface Trail {
    text: string
    html: string
    converter: ReturnType<typeof newConverter>
  }

  /*
   * There are several entries: there can be several outputs on screen at once,
   * and a single entry would mean they take turns knocking each other out and
   * each pays the full price. Eight is enough for the visible part of the
   * notebook, and they hold what lies in the document anyway.
   */
  const trails: Trail[] = []

  function trailFor(body: string): Trail {
    let best: Trail | null = null
    for (const trail of trails) {
      if (!body.startsWith(trail.text)) continue
      if (!best || trail.text.length > best.text.length) best = trail
    }
    if (best) return best
    const fresh: Trail = { text: '', html: '', converter: newConverter() }
    trails.unshift(fresh)
    trails.length = Math.min(trails.length, 8)
    return fresh
  }

  return {
    markdown(source, options = {}) {
      const token = renderToken()
      const formulas: Formula[] = []
      rendering = { token, formulas }
      let raw: string
      try {
        raw = marked.parse(source, { async: false, gfm: true, breaks: true })
      } finally {
        rendering = null
      }
      const holder = document.createElement('div')
      holder.appendChild(
        DOMPurify.sanitize(raw, {
          RETURN_DOM_FRAGMENT: true,
          FORBID_TAGS: MARKDOWN_FORBIDDEN_TAGS,
          FORBID_ATTR: MARKDOWN_FORBIDDEN_ATTRS,
          // Names the page itself answers to stay the page's (lib/sanitize.ts · names).
          ALLOW_DATA_ATTR: false,
          ADD_ATTR: MATH_SLOT_ATTRS,
          SANITIZE_NAMED_PROPS: true,
        }),
      )
      /*
       * A note's styling goes through a property allowlist, and it is computed
       * HERE: after the sanitizer, but BEFORE formulas become markup.
       *
       * The order is not cosmetic. KaTeX lays a formula out with the very
       * properties a note is forbidden — `position: absolute`, `top`, negative
       * offsets in `em` — and if its own output went through this same filter,
       * fractions and radicals would collapse into mush. Our own cannot be told
       * from foreign by the `.katex` class: raw HTML in markdown passes as is,
       * and anyone can write `<span class="katex">`. So the foreign is cleaned
       * while our own is not there yet.
       *
       * The work happens on the detached `holder`: a node outside the document
       * applies nothing and loads nothing by itself, so a `position: fixed`
       * from someone's note does not get to cover the screen, and a
       * `background: url(…)` does not get to leave as a request from the
       * browser of everyone in the room. What goes into the page is a string
       * in which only the allowed part of `style` remains (shared/note-css.ts).
       *
       * An empty result removes the attribute entirely: `style=""` in markup is
       * no better than its absence, and in a version diff it reads as an edit.
       */
      for (const styled of holder.querySelectorAll('[style]')) {
        const kept = safeStyle(styled.getAttribute('style') ?? '')
        if (kept) styled.setAttribute('style', kept)
        else styled.removeAttribute('style')
      }
      /*
       * Classes and references, at the same point and for the same reason as
       * the style: the foreign is cleaned while our own is not there yet.
       * `.table-scroll` and every KaTeX class are added below, after this
       * pass, so the allowlist (lib/sanitize.ts · noteClasses) only has to
       * know the two that arrive through the markup. Without it a note's
       * `class="fixed inset-0 z-[95] bg-canvas"` laid the app's own utilities
       * over the whole room.
       */
      for (const element of holder.querySelectorAll('*')) {
        for (const attribute of [...element.attributes]) {
          if (attribute.name === 'class') {
            const kept = noteClasses(element.localName, attribute.value)
            if (kept) element.setAttribute('class', kept)
            else element.removeAttribute('class')
            continue
          }
          const pointed = noteReference(attribute.name, attribute.value)
          if (pointed !== null) element.setAttributeNS(attribute.namespaceURI, attribute.name, pointed)
        }
      }
      /*
       * Formulas are drawn AFTER the sanitizer, and the order is no accident.
       *
       * KaTeX lays a formula out with inline `style` — height, offset,
       * padding, `position: absolute` in fractions — that is, exactly what a
       * note may not use (shared/note-css.ts), and rightly so. So the markup
       * carries not a finished formula but its TeX in an attribute: the
       * sanitizer passes over it as over text, and so does the styling filter
       * above, and only then does KaTeX build its tree from the TeX, behind
       * their backs. And neither a style nor a tag can be smuggled in through
       * TeX: `trust` is off, and a parse error is output as text.
       *
       * Only the placeholders this render wrote (`formulaAt`, see mathSlot),
       * and each on its own: whatever goes wrong inside KaTeX stays one
       * formula shown as its source, never an exception out of markdown()
       * that takes every note on the page down with it.
       */
      for (const slot of holder.querySelectorAll('[data-math]')) {
        const formula = formulaAt(slot.getAttribute('data-math'), token, formulas)
        slot.removeAttribute('data-math')
        if (!formula) continue
        try {
          slot.innerHTML = katex.renderToString(formula.tex, {
            throwOnError: false,
            displayMode: formula.display,
            output: 'htmlAndMathml',
            trust: false,
            strict: 'ignore',
          })
        } catch {
          slot.textContent = formula.display ? `$$${formula.tex}$$` : `$${formula.tex}$`
        }
      }
      /*
       * A wide table scrolls inside its own wrapper instead of stretching the
       * column.
       *
       * Twelve columns fit neither in a notebook cell nor, all the more, in the
       * 380 px oracle panel, and wrapping text in them "anywhere" means getting
       * twelve columns one letter wide. A wrapper with `overflow-x: auto`
       * (.table-scroll in index.css) is the only place where such scrolling
       * belongs: the feed itself does not scroll sideways.
       *
       * Here and not in a CSS rule on `table`, because markdown provides no
       * wrapper, and `display: block` on the table itself breaks its own
       * layout. And after the sanitizer: we build the node, it does not arrive
       * from someone else's text.
       */
      for (const table of holder.querySelectorAll('table')) {
        const box = document.createElement('div')
        box.className = 'table-scroll'
        table.replaceWith(box)
        box.appendChild(table)
      }
      /*
       * Inert text: on the detached node and before serializing, like the
       * rest of this function, so the page never receives the `<a>` or the
       * `<img>` at all, rather than receiving them and having them hidden.
       */
      if (options.inert) {
        for (const anchor of holder.querySelectorAll('a')) anchor.replaceWith(...anchor.childNodes)
        for (const img of holder.querySelectorAll('img')) {
          img.replaceWith(document.createTextNode(img.getAttribute('alt') ?? ''))
        }
      }
      // A note is written by a classmate; a link in it must not be able to
      // navigate the seminar tab away from the seminar. Every kind of link,
      // not only `<a href>`: an image map's `<area>` and an SVG's
      // `<a xlink:href>` pass the sanitizer and navigate just the same.
      for (const anchor of holder.querySelectorAll('a[*|href], area[href]')) {
        anchor.setAttribute('target', '_blank')
        anchor.setAttribute('rel', 'noopener noreferrer nofollow')
      }
      /*
       * On the node, before serializing, and never as a regex over the result.
       * Browsers before mid-2025 leave `<` unescaped inside attribute values
       * when they serialize, so `alt="<img onerror=…"` in a sanitized note
       * comes out of innerHTML looking like a tag, and a string rewrite that
       * inserts a quote there breaks out of the attribute: stored XSS on a
       * page anyone with the link opens. Nor can it wait for a post-mount
       * action: eager loads start the moment {@html} inserts the markup.
       */
      if (options.lazyImages) {
        for (const img of holder.querySelectorAll('img')) img.setAttribute('loading', 'lazy')
      }
      return holder.innerHTML
    },

    /*
     * Growing output is drawn by its TAIL, not rebuilt whole.
     *
     * The cell's whole accumulated text always arrives here, and the server
     * appends to it every 50 ms: training that prints a log line at a time
     * reaches hundreds of kilobytes by the end, and a full ansi_to_html plus
     * DOMPurify on every flush is a cost that grows quadratically with the
     * output size, for EVERYONE in the room who has the cell on screen. So the
     * converter and the ready HTML are kept next to the text they came from: a
     * continuation arrives — only the continuation is parsed.
     *
     * Colour is not lost by this; on the contrary, this is the only way it
     * works: AnsiUp carries its state from chunk to chunk by itself — which is
     * exactly why the converter lives with its text rather than being created
     * anew. An escape that has started but is not finished stays to wait for
     * the next flush: cut in half, it would colour the rest of the log at
     * random.
     *
     * Text that continues nothing (another cell, `clear_output`) starts an
     * entry of its own and is drawn from scratch — that is, as before.
     */
    ansi(text) {
      const body = text.slice(0, text.length - pendingEscape(text))
      const trail = trailFor(body)
      if (body.length > trail.text.length) {
        const tail = foldAnsiColours(body.slice(trail.text.length))
        trail.html += DOMPurify.sanitize(trail.converter.ansi_to_html(tail))
        trail.text = body
      }
      return trail.html
    },

    // Output keeps its stylesheets for its shadow root (ScopedOutput.svelte),
    // and loses only what reaches past any root: the top layer.
    html: (markup) => DOMPurify.sanitize(markup, { FORBID_ATTR: OUTPUT_FORBIDDEN_ATTRS }),

    svg: (markup) =>
      DOMPurify.sanitize(markup, {
        USE_PROFILES: { svg: true, svgFilters: true, html: true },
        FORBID_ATTR: OUTPUT_FORBIDDEN_ATTRS,
      }),
  }
}

let loaded = $state<Renderers | null>(null)
let inFlight: Promise<Renderers> | null = null

/**
 * Idempotent: a notebook with forty output blocks fetches the chunk once.
 * Safe to call from component init purely to warm it.
 *
 * A failure is not cached. One cut-off request — seminar Wi-Fi, a redeploy
 * under an open tab — would leave the tab without markdown, colours and plots
 * FOREVER: the promise is already rejected, and nobody would create a new one.
 * The next one to need the renderers (a neighbouring cell, a switch to the
 * notebook) tries again.
 */
export function loadRenderers(): Promise<Renderers> {
  return (inFlight ??= importRenderers()
    .then((ready) => {
      loaded = ready
      return ready
    })
    .catch((err: unknown) => {
      inFlight = null
      throw err
    }))
}

/**
 * The renderers if they are here, null if the chunk is still in flight. Reading
 * this inside a $derived is what re-runs a render once it lands.
 */
export function renderers(): Renderers | null {
  return loaded
}
