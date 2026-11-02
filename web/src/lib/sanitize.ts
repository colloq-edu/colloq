/**
 * What a text cell may not carry into everybody else's browser.
 *
 * The notebook is one shared document, so a markdown cell one student types is
 * rendered in every other person's tab, the teacher's included. DOMPurify takes
 * the script out of it: measured by writing fourteen payloads into a live
 * seminar from a second client and reading the result in a real browser, none
 * of them ran — no <script>, no on* attribute, no javascript: href survived.
 *
 * What survived is listed below, and every item on the list is a lever on
 * people other than its author.
 *
 * `style` is not scoped to the cell. `<style>* { display: none }</style>` in a
 * text cell blanks the seminar for the whole room, and `<style>@import
 * "http://…"</style>` had every browser in the room fetch a stranger's URL.
 * A stylesheet reaches the whole page, so it is the one piece of styling a
 * note still may not carry — the style ATTRIBUTE reaches one element, and that
 * one is now filtered by value instead of banned (shared/note-css.ts).
 *
 * `form` survives with its action intact, which puts a button in the middle of
 * the notebook that posts wherever its author chose.
 *
 * `audio` and `video` survive with `autoplay` and `loop`, which is sound in
 * everybody's room that its author does not have to be able to stop.
 *
 * Kernel output keeps all of them, and NOT because output is trusted. The old
 * argument here — "anybody who can make the kernel emit HTML can already run
 * whatever they like" — is about the kernel's container, not about the browsers
 * of the other five hundred people: code in the container cannot blank a
 * classmate's screen, and one `display(HTML(...))` with a hiding rule did
 * exactly that, room-wide and on the projector, for as long as the output
 * stayed in the document.
 *
 * `df.style` is a real pandas feature and it emits a scoped <style>, so the
 * tag stays — the containment is done by construction instead of by a ban:
 * kernel HTML and SVG are drawn inside a shadow root (components/notebook/
 * ScopedOutput.svelte), where a stylesheet reaches only its own subtree — its
 * `:host` included, which is a frame of ours one root down, not the element in
 * the page — `contain: paint` on that element takes the page away from
 * `position: fixed`, and `@import` is stripped in an inert <template> before
 * the markup moves in.
 * That is the whole reason the list above may be shorter for output than for a
 * note: a note is rendered straight into the page, output never is.
 *
 * `dialog` is positioned by the browser's own stylesheet: `<dialog open>`
 * arrives with `position: absolute` and no `style` attribute at all, that is,
 * with the one property shared/note-css.ts exists to refuse. In a room it laid
 * a 700-pixel box over the cells below its own. Nothing in a note can open or
 * close a dialog once the levers below are gone, so the words stay and the box
 * goes (DOMPurify keeps the content of a forbidden tag).
 */
export const MARKDOWN_FORBIDDEN_TAGS = ['style', 'form', 'audio', 'video', 'dialog']

/**
 * And the `style` attribute — it was the other half of that very hole.
 *
 * There is no longer a ban here, and this is why it used to stand here. The
 * `<style>` tag is forbidden, but DOMPurify keeps the ATTRIBUTE by default and
 * does not parse its value at all: neither the CSS nor the addresses inside.
 * `<div style="position:fixed;inset:0;background:#000;z-index:9999">` from a
 * single text cell means a black screen for all thirty people and for the
 * laptop on the projector, and on top of the interface: the cell can no
 * longer be deleted with the mouse, and a reload brings the same cell back.
 *
 * The ban closed that, but along with the hole it took away all the familiar
 * markup of a teaching notebook: `<div style="background:#eef;padding:8px">` —
 * the "Note" inset from every other notebook — arrived as a bare `<div>`, that
 * is, indistinguishable from a paragraph. It read not as "styling is
 * forbidden" but as "HTML does not work": the structure got through, but there
 * was no visible difference.
 *
 * Now what is forbidden is not the attribute but PROPERTIES, and one place
 * decides them — shared/note-css.ts · safeStyle. `background`, `padding`,
 * `border`, `color`, `text-align`, `width` pass; `position`, `z-index`,
 * `transform`, `box-shadow`, `url(...)` do not, and lengths are capped. The
 * sanitizer does not touch the attribute, and render.svelte.ts rewrites its
 * value BEFORE the markup gets into the page: while it lies in a detached
 * node, no rule from it takes effect and no address from it is requested.
 *
 * What remains is `ping`: DOMPurify keeps it by default, and `<a href="…"
 * ping="http://…">` is a POST to a stranger's address from the browser of
 * whoever clicked a link in someone else's note. Styling does not need it,
 * while as a lever on the reader it is very real, and it is visible only in
 * the link's source.
 *
 * `input` and `canvas` are deliberately NOT in the tag list: a checkbox is a
 * GFM task list (`- [ ] do it`), and a canvas without a script, which cannot
 * be smuggled in here, draws nothing.
 *
 * The popover family came into DOMPurify's defaults with the browsers that
 * learned it, and it is the one way left to draw above the interface without
 * a script: `<button popovertarget="x">` opens `<div popover id="x">` in the
 * TOP LAYER, above every z-index and outside every `contain`. Measured: one
 * click on a "Show the answer" button in a classmate's note put a black
 * `width: 100%; height: 100%` box over the whole room, and with
 * `popover="manual"` Escape does not close it — only a reload did. `command`
 * and `commandfor` are the same lever for a dialog (`show-modal`), and both
 * name their target by id, which can be one of the page's own.
 *
 * `tabindex` is the keyboard's version of the same thing: a positive one puts
 * a note's element ahead of the whole interface in the Tab order of everyone
 * who reads the room without a mouse. Nothing in a note needs focus it does
 * not already get from a link.
 */
export const MARKDOWN_FORBIDDEN_ATTRS = ['ping', ...topLayer(), 'tabindex']

/**
 * What kernel output may not carry even inside its shadow root.
 *
 * The root and the host's `contain: paint` hold every box the output can lay
 * out — and the top layer is not laid out inside anything: it is above the
 * page by definition. A `display(HTML(...))` with `<button popovertarget>`
 * and `<div popover="manual">` covered the room after one click on the
 * button, from inside the root, past the containment (measured). No library
 * draws a table or a plot with these.
 */
export const OUTPUT_FORBIDDEN_ATTRS = topLayer()

/** The attributes that open an element in the top layer: popovers, and dialogs by `command="show-modal"`. */
function topLayer(): string[] {
  return ['popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor']
}

/*
 * Names: what a note may still call things, after the lists above.
 *
 * A note's markup goes into the page itself, and the page answers to names —
 * so a name in a note is a lever on the page the moment it is one the page
 * uses. That is the whole hole, three times over:
 *
 * - CLASS. The app is styled by utility classes, and every one of them is in
 *   the stylesheet a note is drawn under. `<div class="fixed inset-0 z-[95]
 *   bg-canvas">` needs no `style` at all: measured on the production build, it
 *   covered the whole room, every control included, for everyone who opened
 *   the notebook and for as long as the cell lived. The style allowlist
 *   (shared/note-css.ts) never saw it — it reads `style`, and this was not
 *   one.
 * - DATA-*. The notebook finds its own cells by `[data-cell-id]` and measures
 *   them by `[data-cell-slot]`, and `querySelector` answers with the first
 *   match in the document: a note above a cell that carried that cell's id
 *   took the jumps, the follow-the-run scrolling and the scroll anchoring meant
 *   for the real one.
 * - ID. `getElementById`, a `#hash`, `aria-labelledby` and `<label for>` all
 *   resolve to the first element with that id, the note's as readily as the
 *   page's own: the class page's outline and its deep links scrolled to the
 *   note's.
 *
 * So classes pass through an allowlist of the few the renderer's own pipeline
 * needs, `data-*` does not pass at all (DOMPurify's ALLOW_DATA_ATTR: false —
 * the math placeholders are the renderer's and are let through by name, see
 * render.svelte.ts), and ids and names move into a namespace of their own,
 * `user-content-`, the one DOMPurify uses for SANITIZE_NAMED_PROPS and the one
 * GitHub renders README anchors in. A note's REFERENCES move with them —
 * `for`, `aria-describedby`, `href="#…"`, an SVG's `url(#…)` — so its own
 * links, labels, gradients and arrowheads keep finding each other, and only
 * each other.
 */

/** The namespace a note's ids and names live in. DOMPurify's SANITIZE_NAMED_PROPS prefix, to the letter. */
export const NOTE_NAME_PREFIX = 'user-content-'

/**
 * Whether a class may stay on an element of a note.
 *
 * Two, and each has a reason to arrive through the markup rather than be
 * added after the sanitizer the way `.table-scroll` and KaTeX's classes are.
 * `language-*` is what marked writes on a fenced block (```` ```python ````);
 * the app styles no `language-*` class and must not start to. `ai-caret` is
 * the oracle's typing cursor, appended to the answer's text while it streams
 * (panels/AnswerBody.svelte): a small inline box in the accent colour, which
 * is all it can ever be in anyone's note too.
 */
function keepsClass(tag: string, token: string): boolean {
  if (tag === 'code' && /^language-[\w#+.-]+$/.test(token)) return true
  return tag === 'span' && token === 'ai-caret'
}

/** The classes an element of a note keeps. The empty string removes the attribute. */
export function noteClasses(tag: string, value: string): string {
  return value
    .split(/\s+/)
    .filter((token) => token && keepsClass(tag, token))
    .join(' ')
}

/** Attributes whose value is an id or a list of ids. */
const ID_REFERENCES: ReadonlySet<string> = new Set([
  'for',
  'headers',
  'list',
  'aria-activedescendant',
  'aria-controls',
  'aria-describedby',
  'aria-details',
  'aria-errormessage',
  'aria-flowto',
  'aria-labelledby',
  'aria-owns',
])

/** Attributes whose value is an address — one that points into the page when it starts with `#`. */
const ADDRESSES: ReadonlySet<string> = new Set(['href', 'xlink:href', 'usemap'])

/** An SVG's paint, marker, clip and filter: they point at their definitions with `url(#…)`. */
const PAINT_REFERENCES: ReadonlySet<string> = new Set([
  'fill',
  'stroke',
  'clip-path',
  'mask',
  'filter',
  'marker-start',
  'marker-mid',
  'marker-end',
])

/** A name in the note's own namespace. Already there stays as is, as DOMPurify itself does. */
const ownName = (name: string): string => (name.startsWith(NOTE_NAME_PREFIX) ? name : NOTE_NAME_PREFIX + name)

/** `url(#name)` not yet in the namespace; the quote, if any, is kept. */
const LOCAL_URL = new RegExp(`url\\(\\s*(['"]?)\\s*#(?!${NOTE_NAME_PREFIX})`, 'gi')

/**
 * A note's reference to a name, pointed at the note's own namespace — or
 * `null` when the attribute refers to nothing in the page and stays as it is.
 *
 * `href="#"` alone is "the top", not a name, and an address elsewhere is not
 * a name in this page at all.
 */
export function noteReference(attribute: string, value: string): string | null {
  if (ID_REFERENCES.has(attribute)) {
    return value.split(/\s+/).filter(Boolean).map(ownName).join(' ')
  }
  if (ADDRESSES.has(attribute)) return /^#./.test(value) ? `#${ownName(value.slice(1))}` : null
  if (!PAINT_REFERENCES.has(attribute)) return null
  const pointed = value.replace(LOCAL_URL, `url($1#${NOTE_NAME_PREFIX}`)
  return pointed === value ? null : pointed
}
