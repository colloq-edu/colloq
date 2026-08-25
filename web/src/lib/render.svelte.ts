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

/** What the module exposes once the chunk has landed. */
export interface Renderers {
  /** Untrusted markdown -> sanitized HTML, external links defused. */
  markdown: (source: string) => string
  /** Terminal/stdout text -> sanitized HTML with the ANSI colours kept. */
  ansi: (text: string) => string
  /** Untrusted HTML (a DataFrame repr, a rich output) -> sanitized HTML. */
  html: (markup: string) => string
  /** Untrusted SVG (a matplotlib figure) -> sanitized SVG. */
  svg: (markup: string) => string
}

/*
 * Narrowing happens in the .then PARAMETER on purpose. Hand Rollup a whole
 * module namespace — `.then((m) => m.marked)` counts as whole — and it has to
 * assume every export of the package is live, which measured 28 KB of dead
 * CodeMirror when the editor was split the same way.
 */
async function importRenderers(): Promise<Renderers> {
  const [{ marked }, { DOMPurify }, { AnsiUp }] = await Promise.all([
    import('marked').then(({ marked }) => ({ marked })),
    import('dompurify').then(({ default: DOMPurify }) => ({ DOMPurify })),
    import('ansi_up').then(({ AnsiUp }) => ({ AnsiUp })),
  ])

  return {
    markdown(source) {
      const raw = marked.parse(source, { async: false, gfm: true, breaks: true })
      const holder = document.createElement('div')
      holder.appendChild(DOMPurify.sanitize(raw, { RETURN_DOM_FRAGMENT: true }))
      // A note is written by a classmate; a link in it must not be able to
      // navigate the seminar tab away from the seminar.
      for (const anchor of holder.querySelectorAll('a[href]')) {
        anchor.setAttribute('target', '_blank')
        anchor.setAttribute('rel', 'noopener noreferrer nofollow')
      }
      return holder.innerHTML
    },

    /*
     * A fresh converter per call: AnsiUp carries colour state from one call to
     * the next, and we always hand it the whole accumulated text rather than
     * the newest chunk, so a reused converter would tint from where it left off.
     */
    ansi(text) {
      const converter = new AnsiUp()
      converter.escape_html = true
      converter.use_classes = false
      return DOMPurify.sanitize(converter.ansi_to_html(text))
    },

    html: (markup) => DOMPurify.sanitize(markup),

    svg: (markup) =>
      DOMPurify.sanitize(markup, { USE_PROFILES: { svg: true, svgFilters: true, html: true } }),
  }
}

let loaded = $state<Renderers | null>(null)
let inFlight: Promise<Renderers> | null = null

/**
 * Idempotent: a notebook with forty output blocks fetches the chunk once.
 * Safe to call from component init purely to warm it.
 */
export function loadRenderers(): Promise<Renderers> {
  return (inFlight ??= importRenderers().then((ready) => {
    loaded = ready
    return ready
  }))
}

/**
 * The renderers if they are here, null if the chunk is still in flight. Reading
 * this inside a $derived is what re-runs a render once it lands.
 */
export function renderers(): Renderers | null {
  return loaded
}

/*
 * Fallback for the window before the chunk lands. Colour is the only thing
 * lost — dropping the escape codes leaves exactly the text the kernel printed,
 * and it goes out as text, never as markup, so it needs no sanitizer.
 *
 * Covers CSI (\x1b[…), the two-character sequences, and OSC strings, which
 * carry a title or a hyperlink and would otherwise show as visible garbage.
 */
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- escape codes are the subject
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}
