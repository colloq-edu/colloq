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
 * ScopedOutput.svelte), where a stylesheet reaches only its own subtree,
 * `contain: paint` on the host takes the page away from `position: fixed`, and
 * `@import` is stripped in an inert <template> before the markup moves in.
 * That is the whole reason the list above may be shorter for output than for a
 * note: a note is rendered straight into the page, output never is.
 */
export const MARKDOWN_FORBIDDEN_TAGS = ['style', 'form', 'audio', 'video']

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
 */
export const MARKDOWN_FORBIDDEN_ATTRS = ['ping']
