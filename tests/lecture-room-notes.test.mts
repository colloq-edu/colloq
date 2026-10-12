/**
 * The presenter's notes on the laptop keep the field the presenter types in.
 *
 * Two ways the field used to be taken away from under the caret, each
 * followed by the sentence the presenter went on typing landing in the
 * lecture's shortcuts (Space turns the hall's slide, B blanks the projector,
 * "E E" erases the page's ink for the whole hall):
 *
 *  • the room's middle crossing 1024 px (⌘B on the files panel, the Oracle,
 *    the browser's zoom) swapped the column beside the slide for the card
 *    under it, two NotesPads behind two `{#if}`s. Now one box holds one
 *    NotesPad in both places, and the flip moves it by its classes
 *    (LectureView · `notesBox`);
 *  • a clicker walk onto a sheet swapped the field for a line of text. Now
 *    the field stays on a sheet, read-only, saying sheets have no notes.
 *
 * And a draft over the ceiling outlives the home it was typed in.
 *
 * NotesPad is rendered on the server (svelte/server), with a stand-in for
 * the session; LectureView's wiring is held by its source.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import { translate } from '../shared/i18n.js'

function code(rel: string): string {
  // Markup without comments: an explanation is not a promise.
  return fs
    .readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
}

/* --------------------------------------------- NotesPad, rendered */

let dir: string
let NotesPad: Component<any>
before(async () => {
  // The size step reads it; Node's own warns on every touch without a file behind it.
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => null, setItem: () => {} },
    configurable: true,
  })
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-notes-pad-'))
  // The session and the icon set stand in: neither is what is checked here.
  const session = path.join(dir, 'session.mjs')
  await writeFile(session, 'export function getSessionState() { return globalThis.__notesPadSession }\n')
  const icon = path.join(dir, 'icon.mjs')
  await writeFile(icon, 'export default function Icon() {}\n')
  const source = await readFile(new URL('../web/src/components/lecture/NotesPad.svelte', import.meta.url), 'utf8')
  let js = compile(source, { filename: 'NotesPad.svelte', generate: 'server' }).js.code
  for (const [from, to] of [
    ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
    ['svelte', import.meta.resolve('svelte')],
    ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
    ['@shared/lecture', new URL('../shared/lecture.ts', import.meta.url).href],
    ['@/components/ui/Icon.svelte', pathToFileURL(icon).href],
    ['@/lib/session.svelte', pathToFileURL(session).href],
    ['./pult', new URL('../web/src/components/lecture/pult.ts', import.meta.url).href],
  ]) js = js.replaceAll(`'${from}'`, JSON.stringify(to))
  const file = path.join(dir, 'NotesPad.mjs')
  await writeFile(file, js)
  NotesPad = (await import(pathToFileURL(file).href)).default
})
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

const FILE = 'lecture.pdf'
function pad(props: Record<string, unknown>): string {
  ;(globalThis as Record<string, unknown>).__notesPadSession = {
    me: { role: 'host' },
    notesFile: FILE,
    notes: { 14: 'Сначала вопрос залу.' },
    lecture: null,
    clockSkewMs: 0,
    openNotes() {},
    send() {},
  }
  return render(NotesPad, { props: { file: FILE, compact: true, ...props } }).body
}
/** The notes field, as rendered: the one tag. */
function field(html: string): string | null {
  return /<textarea\b[^>]*>/.exec(html)?.[0] ?? null
}

test('on a slide the presenter writes into the field, and the clicker turns pages from it', () => {
  const textarea = field(pad({ page: 14 }))
  assert.ok(textarea, 'the field is gone from a slide')
  assert.match(textarea, /\bdata-notes\b/, 'the clicker no longer turns pages from the field')
  assert.doesNotMatch(textarea, /\breadonly\b/)
  assert.match(textarea, new RegExp(`placeholder="${translate('ru', 'room.ui.195')}"`))
})

test('on a sheet the field stays where it was, read-only, and says sheets have no notes', () => {
  const html = pad({ page: -1 })
  const textarea = field(html)
  assert.ok(textarea, 'a sheet swaps the field for text again: the caret in it is lost on a clicker walk')
  assert.match(textarea, /\breadonly\b/, 'a sheet takes a note the server will refuse')
  assert.match(textarea, /\bdata-notes\b/, 'the clicker stops turning pages from the field on a sheet')
  const none = translate('ru', 'room.ui.314')
  assert.match(textarea, new RegExp(`placeholder="${none}"`))
  assert.match(textarea, new RegExp(`aria-label="${none}"`), 'a sheet is labelled "notes for page −1" again')
})

test('the console still reads its notes as text, never as a field, on a slide and on a sheet', () => {
  for (const page of [14, -1]) {
    const html = pad({ page, readonly: true, compact: false, docked: true })
    assert.equal(field(html), null, `the console grew a field on page ${page}`)
  }
  assert.match(pad({ page: -1, readonly: true, compact: false, docked: true }), new RegExp(translate('ru', 'room.ui.314')))
})

test('the header under the slide says the next item by its mark and its words', () => {
  const html = pad({ page: 14, next: { mark: 'Л1', title: 'лист 1 из 2' } })
  assert.match(html, />Л1</)
  assert.match(html, />лист 1 из 2</)
  assert.match(html, new RegExp(`>${translate('ru', 'room.ui.197')}<`))
  assert.doesNotMatch(pad({ page: 14 }), />Л1</, 'a header with no "next" says one')
})

test('a draft over the ceiling is kept beside the component, by document and page, not in one instance', () => {
  const view = code('web/src/components/lecture/NotesPad.svelte')
  const module = /<script module lang="ts">([\s\S]*?)<\/script>/.exec(view)?.[1] ?? ''
  assert.match(module, /const overDrafts = new Map<string, string>\(\)/, 'the drafts live and die with one instance again')
  const instance = view.slice(view.indexOf('<script lang="ts">'))
  assert.doesNotMatch(instance, /new Map/, 'a second map of drafts in the instance')
  assert.match(instance, /overDrafts\.set\(draftKey\(heldFile, heldPage\), held\)/)
  assert.match(instance, /overDrafts\.get\(draftKey\(nextFile, nextPage\)\) \?\? stored/)
})

/* ---------------------------------------- LectureView: one field, moved */

const VIEW = code('web/src/components/lecture/LectureView.svelte')
/** The room's content when the document opened: from the failure branch's `{:else}` to the section's end. */
function content(): string {
  const failure = VIEW.indexOf('{#if failure}', VIEW.indexOf('<section'))
  const from = VIEW.indexOf('{:else}', VIEW.indexOf('</aside>', failure))
  return VIEW.slice(from, VIEW.indexOf('</section>', from))
}

test('the presenter\'s notes are one NotesPad, in one box that the flip at 1024 moves', () => {
  const room = content()
  // One for the presenter, one for a teacher watching: never a second for the presenter.
  assert.equal((room.match(/<NotesPad\b/g) ?? []).length, 2, 'the presenter has two notes fields again')
  assert.doesNotMatch(room, /\{#if stacked\}/, 'the card under the slide is a component of its own again')
  assert.match(VIEW, /const notesBox = \$derived\(column \|\| stacked\)/)
  const box = room.slice(room.indexOf('{#if notesBox}'))
  assert.notEqual(box.length, room.length, 'the notes box is gone')
  const presenter = box.slice(0, box.indexOf('{#if cohost && host && notesShown && notesRoom}'))
  assert.match(presenter, /\{#if speaker\}[\s\S]*<NotesPad\b/, 'the presenter\'s notes left the box')
  // The box is placed by its classes: beside the slide, or under it as wide as the slide.
  assert.match(
    presenter,
    /<aside\s+class="flex flex-col \{stacked \? 'min-h-0 flex-1 self-center' : 'w-\[28%\] shrink-0 gap-3'\}"\s+style:width=\{stacked \? `\$\{stackW\}px` : null\}/,
  )
  // The area turns from a row into a column, and the slide's height is
  // counted from the area, never from a column that holds the slide alone.
  assert.match(room, /<div class="relative flex min-h-0 flex-1 gap-3 p-3 \{stacked \? 'flex-col' : ''\}" bind:clientHeight=\{areaH\}>/)
  assert.match(VIEW, /const colH = \$derived\(Math\.max\(0, areaH - 2 \* AREA_PAD_PX\)\)/)
  assert.doesNotMatch(VIEW, /bind:clientHeight=\{colH\}/)
})

test('the clicker turns pages from the notes field before anything else treats it as typing', () => {
  const keys = VIEW.slice(VIEW.indexOf('function onkeydown('))
  const clicker = keys.indexOf("if (clicker && target?.closest('[data-notes]'))")
  const typing = keys.indexOf("if (target?.closest('input, textarea, [contenteditable]')) return")
  assert.ok(clicker > 0 && typing > clicker, 'PageUp/PageDown from the notes no longer turn the slide')
})
