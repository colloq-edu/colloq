<script lang="ts" module>
  /**
   * Rich kernel output — in a shadow root, not in the page.
   *
   * By default DOMPurify keeps the style tag, and that is right for exactly the
   * reason it was kept: `df.style` is a real pandas feature, and matplotlib in
   * svg mode puts its rules straight into `defs`. But a style tag inside the
   * page is a stylesheet for the WHOLE page, and a single line of
   * `display(HTML(...))` with a hide-everything rule blanked the screen for the
   * whole room and on the projector: the output lives in the document, a reload
   * brought back the same thing, and the Clear button ended up hidden along
   * with everything else. A harmless version of the same hole is
   * `stroke-linecap` from matplotlib, after which everyone's interface icons
   * changed.
   *
   * The argument "whoever can make the kernel emit HTML can do anything anyway"
   * is about the kernel's container, not about the neighbours' browsers: code
   * in the container cannot blank other people's screens, HTML output could.
   * And it flatly contradicted the fact that the same tag is forbidden in
   * notes — in a room with `run: room` any student emits HTML with a single
   * line.
   *
   * A shadow root closes this by construction, not by prohibition: the rules
   * inside it apply only inside it, and `df.style` keeps working exactly as it
   * did. The table styling moves in there too — from outside it would no longer
   * reach.
   *
   * `contain: paint` on the host closes the second half: it makes the element
   * the containing block for `position: fixed` descendants and clips painting
   * to the element's own box. The attribute `style="position:fixed;inset:0"` —
   * the very hole that was closed for notes by forbidding the attribute — no
   * longer covers the screen.
   */

  /** Shared by both kinds: the shadow root's host is an ordinary block. */
  const BASE = `
    :host { display: block; }
    :host([hidden]) { display: none; }
  `

  /**
   * Styling for a pandas table. It used to live in CellOutputs' own styles via
   * `:global`; it has to move into the shadow root in full, otherwise the table
   * will arrive with its own light borders on top of the dark theme.
   *
   * `!important` stays: the kernel sends its own rules, and they land in the
   * same root AFTER these.
   */
  const HTML_CSS = `${BASE}
    table { border-collapse: collapse; margin: 2px 0; }
    th, td {
      border: 1px solid rgb(var(--line)) !important;
      padding: 3px 8px !important;
      color: rgb(var(--ink)) !important;
      text-align: right;
      white-space: nowrap;
    }
    thead th {
      background: rgb(var(--raised)) !important;
      color: rgb(var(--muted)) !important;
      font-weight: 600;
    }
    tbody th { color: rgb(var(--muted)) !important; text-align: left; }
    tbody tr:hover td { background: rgb(var(--raised) / 0.55) !important; }
    a { color: rgb(var(--accent)); text-decoration: underline; }
    pre {
      font-family: var(--font-mono);
      white-space: pre-wrap;
    }
  `

  const SVG_CSS = `${BASE}
    svg { max-width: 100%; height: auto; }
  `

  export const SCOPE_CSS: Record<'html' | 'svg', string> = { html: HTML_CSS, svg: SVG_CSS }
</script>

<script lang="ts">
  interface Props {
    /** Markup already passed through lib/render. Nothing raw gets here. */
    markup: string
    /** Which rule set to put into the root next to it. */
    kind: 'html' | 'svg'
    class?: string
  }

  let { markup, kind, class: className = '' }: Props = $props()

  let host = $state<HTMLDivElement | null>(null)

  $effect(() => {
    const node = host
    const body = markup
    const css = SCOPE_CSS[kind]
    if (!node) return
    // A second attachShadow on the same node throws, and the node survives a
    // change of output: the root is created once and afterwards only rewritten.
    const shadow = node.shadowRoot ?? node.attachShadow({ mode: 'open' })

    /*
     * The markup is assembled in a `template`, not written into the root
     * directly.
     *
     * The content of a `template` is inert: the browser does not apply it and
     * loads nothing for it until the nodes are moved into the document. That is
     * exactly the window in which `@import` can be removed — the second half of
     * the same hole as the global rules. The scope defuses it only halfway: the
     * rules apply only inside the root, but the ADDRESS would still be
     * requested from the browser of everyone in the room. Were we to write
     * straight into the root, the request would go out at that very moment, and
     * it would be too late to clean up.
     */
    const template = document.createElement('template')
    template.innerHTML = body
    for (const sheet of template.content.querySelectorAll('style')) {
      const text = sheet.textContent ?? ''
      if (text.includes('@import')) sheet.textContent = text.replace(/@import\s[^;]*;?/gi, '')
    }

    // As an element, not as a string in markup: a string with a style tag
    // inside a .svelte file breaks the parsing of the component itself.
    const rules = document.createElement('style')
    rules.textContent = css
    shadow.replaceChildren(rules, template.content)
  })
</script>

<!-- The shadow root's host. `contain: paint` is not about speed but about
     `position: fixed` from inside no longer reaching the window. -->
<div bind:this={host} class={className} style="contain: paint"></div>
