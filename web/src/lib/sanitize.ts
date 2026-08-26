/**
 * What a text cell may not carry into everybody else's browser.
 *
 * The notebook is one shared document, so a markdown cell one student types is
 * rendered in every other person's tab, the teacher's included. DOMPurify takes
 * the script out of it: measured by writing fourteen payloads into a live
 * seminar from a second client and reading the result in a real browser, none
 * of them ran — no <script>, no on* attribute, no javascript: href survived.
 *
 * Two tags did survive, and both are a lever on people other than their author.
 *
 * `style` is not scoped to the cell. `<style>* { display: none }</style>` in a
 * text cell blanks the seminar for the whole room, and `<style>@import
 * "http://…"</style>` had every browser in the room fetch a stranger's URL.
 * Nothing a person writes in a note has ever needed a stylesheet.
 *
 * `form` survives with its action intact, which puts a button in the middle of
 * the notebook that posts wherever its author chose.
 *
 * Kernel output keeps both. `df.style` is a real pandas feature and it emits a
 * scoped <style>; and anybody who can make the kernel emit HTML can already run
 * whatever they like inside it, so there is nothing left there to protect.
 */
export const MARKDOWN_FORBIDDEN_TAGS = ['style', 'form']
