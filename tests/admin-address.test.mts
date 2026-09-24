/**
 * The panel: a former address, a finger and one language per surface.
 *
 * Three places where the panel promised more than it showed.
 *
 * The first is a former name in the address. The server learned to name the
 * holder and to return its former names (server/src/routes/courses.ts ·
 * former, addressHolder), but there was still nowhere to release them: the
 * course "ML 2025", renamed to "ml-2025-fall", holds "ml-2025" for itself
 * forever, and the owner could not see that it is exactly this course that
 * holds it: there is no row with that address in the list. We check that the
 * list exists on both screens, that the price is named NEXT to the button
 * and not only in the question after it, and that the irreversible part
 * comes as a second step.
 *
 * The second is the "copy" icon at the seminar address.
 * `hoverOnlyWhenSupported` (tailwind.config.js) rightly removed sticky hover
 * from touch screens, but this icon was the row's ONLY hint that it can be
 * pressed, and on the iPad it stopped appearing at all.
 *
 * The third is language. The panel and the shared rules component follow
 * the instance language. Both languages are checked: captions of one
 * surface must not mix.
 *
 * It is read straight from the components, as in `panels-craft.test.mts`
 * and `panels-touch.test.mts`: a test with its own copy of the rule passes
 * forever while the file drifts away.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { translate, type Locale } from '../shared/i18n.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup without comments: an explanation is not a promise. */
function code(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** Resolve explicit static message calls for source-level copy/layout contracts. */
function localized(source: string, locale: Locale): string {
  return source.replace(/\btr\(\s*['"]([^'"]+)['"]\s*\)/g, (_match, key: string) => translate(locale, key))
}

/** Line breaks are a matter of formatting, not meaning. */
const flat = (source: string): string => source.replace(/\s+/g, ' ')

const COURSES = 'web/src/admin/screens/Courses.svelte'
const PUBLISH = 'web/src/admin/screens/Publish.svelte'
const SEMINARS = 'web/src/admin/screens/Seminars.svelte'
const ENVIRONMENTS = 'web/src/admin/screens/Environments.svelte'

/* ---------------------------------------------- former names in the address */

test('former names of a course are visible where they were changed', () => {
  const courses = code(read(COURSES))
  // The list comes from the server, not assembled by the screen from its own
  // renames: an address is freed in September of the following year, from
  // another tab and by other hands (server/src/routes/courses.ts:128,153 ·
  // former).
  assert.match(courses, /const former = \$derived\(course\?\.former \?\? \[\]\)/)
  assert.match(courses, /\{#each former as name \(name\)\}/)
  assert.match(courses, /\/c\/\{name\}/, 'the name is shown as an address, not as a bare string')
})

test('the price of releasing is named at the button itself, not only in the question', () => {
  const courses = flat(localized(code(read(COURSES)), 'ru'))
  const list = courses.slice(courses.indexOf('Прежние адреса'), courses.indexOf('{#each former'))
  assert.ok(list.length > 0, 'the former addresses block was not found')
  // A link written down in last year's group chat answers 404 after this,
  // and people read about it BEFORE pressing, not in a dialog on top of it.
  assert.match(list, /перестанет вести сюда/)
  assert.match(list, /сможет занять другой курс/, 'and why people do it is said too')
})

test('releasing is a second step: the button asks a question, it does not act', () => {
  const courses = code(read(COURSES))
  // A press in the list only asks; the request itself goes from the dialog.
  assert.match(courses, /onclick=\{\(\) => \(dropping = name\)\}/)
  const asked = courses.indexOf('id="drop-slug-title"')
  assert.ok(asked > 0, 'there is no question dialog at all')
  assert.ok(
    courses.indexOf('void dropFormer()') > asked,
    'the irreversible action is called past the question; that cannot be called a second step',
  )
  // And the question names that very address, not "related data".
  assert.match(courses, /tr\('admin\.course\.releaseHeading', \{ address: going \}\)/)
  assert.equal(translate('ru', 'admin.course.releaseHeading', { address: 'old-course' }), 'Освободить адрес /c/old-course?')
  assert.equal(translate('en', 'admin.course.releaseHeading', { address: 'old-course' }), 'Release address /c/old-course?')
})

test('the owner releases their own: the route is called with the course id', () => {
  const courses = code(read(COURSES))
  assert.match(courses, /adminApi\.releaseFormerSlug\('course', open\.id, name\)/)
  // The server recomputes the list: our own copy of the answer would diverge
  // from it at the very first refusal (server/src/publish/store.ts ·
  // releaseFormerSlug → 404).
  assert.match(
    code(read(COURSES)).slice(courses.indexOf('async function dropFormer')),
    /await loadOne\(open\.id\)/,
  )
})

test('a page knows its former names even before it is republished', () => {
  const publish = code(read(PUBLISH))
  // The list used to be filled only by renames IN THIS TAB: a screen opened a
  // year later showed emptiness, and there was nothing to release in it.
  assert.match(publish, /former = already\?\.former \?\? \[\]/)
  assert.match(publish, /\{#snippet formerNames\(\)\}/, 'the list is needed in two places on the screen')
  const renders = publish.match(/\{@render formerNames\(\)\}/g) ?? []
  assert.equal(renders.length, 2, 'a page just published, and one published earlier')
})

test('a publication releases the same thing in the same way', () => {
  const publish = code(read(PUBLISH))
  const flatPublish = flat(localized(publish, 'ru'))
  const list = flatPublish.slice(
    flatPublish.indexOf('Прежние адреса'),
    flatPublish.indexOf('{#each former'),
  )
  assert.match(list, /перестанет вести сюда/, 'the price is named at the button')
  assert.match(publish, /adminApi\.releaseFormerSlug\('publication', page, name\)/)
  // The id is the page's, not today's press of "Publish": the former names
  // belong to it even when it was published last year.
  assert.match(publish, /const pageId = \$derived\(done \?\? already\?\.id \?\? null\)/)
  assert.ok(
    publish.indexOf('void dropFormer()') > publish.indexOf('id="drop-slug-title"'),
    'the irreversible action is called past the question',
  )
})

/* ------------------------------------------------------------------ finger */

test('the "copy" icon at the seminar address is visible without hovering', () => {
  const seminars = code(read(SEMINARS))
  // Exactly the button that carries the address in the list row: `data-copy`
  // is its mark, and the page itself finds the button by it when answering ⌘C.
  const row = seminars.slice(seminars.indexOf('data-copy={seminar.id}'))
  const icon = row.slice(row.indexOf('<Icon'))
  const shown = flat(icon.slice(0, icon.indexOf('/>')))
  assert.match(shown, /group-hover:opacity-100/, 'for a pointer, on hover')
  assert.match(shown, /group-focus-within:opacity-100/, 'for the keyboard, on focus within the row')
  // Where there is no hover at all (the iPad the panel is opened from), the
  // hint that the row can be pressed must always be there: hover utilities no
  // longer reach there (tailwind.config.js · hoverOnlyWhenSupported).
  assert.match(shown, /\[@media\(hover:none\)\]:opacity-100/)
})

/* -------------------------------------------------- one language per surface */

test('the seminar row menu follows the instance language entirely', () => {
  const seminars = code(read(SEMINARS))
  const opened = seminars.indexOf('role="menu"')
  const menu = seminars.slice(opened, seminars.indexOf('</tr>', opened))
  const en = localized(menu, 'en')
  const ru = localized(menu, 'ru')
  assert.ok(en.includes('Copy link') && en.includes('Delete…'), 'the menu was not found')
  assert.ok(ru.includes('Копировать ссылку') && ru.includes('Удалить…'))
  assert.doesNotMatch(en, /[А-Яа-яЁё]/)
  assert.doesNotMatch(ru, /Copy link|Delete…|End the class/)
})

test('the rules window frame and the shared component use the instance language', () => {
  const seminars = code(read(SEMINARS))
  const dialog = seminars.slice(seminars.indexOf('aria-labelledby="seminar-rules-title"'))
  const window_ = dialog.slice(0, dialog.indexOf('{#if doomed}'))
  assert.ok(window_.includes('RoomRulesRows'), 'the rules window was not found')
  assert.match(localized(window_, 'ru'), /права участников/)
  assert.match(localized(window_, 'en'), /participant permissions/)
  assert.match(read(SEMINARS), /RoomRulesRows\.svelte/)
})

test('the environments screen follows the chosen language entirely', () => {
  const source = code(read(ENVIRONMENTS))
  assert.doesNotMatch(localized(source, 'en'), /[А-Яа-яЁё]/)
  assert.match(localized(source, 'ru'), /Окружения/)
  assert.match(localized(source, 'ru'), /срезы GPU/)
})
