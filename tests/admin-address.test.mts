/**
 * The panel: a former address, a finger, one language per surface and one
 * way to show an address.
 *
 * Four places where the panel promised more than it showed.
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
 * The fourth is a competition's address. A course's screen says its address
 * under the title, in mono, with «открыть» and «скопировать» beside it; the
 * competition console had a framed «Ссылка участникам» among its actions
 * instead, which looked like nothing else in the panel (the owner asked for
 * the course's buttons on 21 Oct 2026). Both headers now draw it one way —
 * the two links as one pair that wraps together, and no rule a line can end
 * on in the console — a refused copy keeps its link on screen however the
 * feed moves, and a draft's editor names its address without links /k
 * cannot serve yet.
 *
 * It is read straight from the components, as in `panels-craft.test.mts`
 * and `panels-touch.test.mts`: a test with its own copy of the rule passes
 * forever while the file drifts away.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasTranslation, translate, type Locale } from '../shared/i18n.js'

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
const RESOURCES = 'web/src/admin/screens/ResourcesTab.svelte'
const RUNNING = 'web/src/admin/ui/RunningKernels.svelte'
const RUNNING_WORDS = 'web/src/admin/running-kernels.ts'
const LIVE = 'web/src/admin/screens/competitions/Live.svelte'
const EDITOR = 'web/src/admin/screens/competitions/Editor.svelte'

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
  assert.match(publish, /\{#snippet formerNames\(\)\}/)
  // The address block is there whenever a page exists — just published or
  // published a year ago — so the list is drawn once, inside it.
  const renders = publish.match(/\{@render formerNames\(\)\}/g) ?? []
  assert.equal(renders.length, 1)
  const block = publish.slice(publish.indexOf('{#if already}', publish.indexOf("tr('admin.page.address')")))
  assert.ok(block.indexOf('{@render formerNames()}') < block.indexOf('{:else}'), 'under the page that has the names')
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
  assert.match(publish, /const pageId = \$derived\(already\?\.id \?\? null\)/)
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

test('the resources screen follows the chosen language entirely', () => {
  const source = code(read(RESOURCES))
  assert.doesNotMatch(localized(source, 'en'), /[А-Яа-яЁё]/)
  assert.match(localized(source, 'ru'), /Как поделена машина/)
  assert.match(localized(source, 'en'), /How the machine is divided/)
})

test('«Работают сейчас» follows the chosen language entirely, and so do its words', () => {
  // October 2026: the list the owner frees memory from. The component and
  // the module that words its rows and dialogs are one surface.
  const source = code(read(RUNNING))
  assert.doesNotMatch(localized(source, 'en'), /[А-Яа-яЁё]/)
  assert.match(localized(source, 'en'), /Stop anyway/)
  const words = code(read(RUNNING_WORDS))
  assert.match(localized(words, 'ru'), /Сейчас ни одно ядро не запущено\./)
  assert.match(localized(words, 'en'), /No kernel is running right now\./)
  assert.doesNotMatch(localized(words, 'en'), /[А-Яа-яЁё]/)
  assert.match(localized(words, 'ru'), /не остановится сам/)
  // The section stands on the resources screen, outside the owner-only
  // fieldset: a teacher reads it, and a disabled fieldset would grey it out.
  const resources = code(read(RESOURCES))
  const section = resources.indexOf('<RunningKernels ')
  assert.ok(section > 0, 'the list is on the resources screen')
  assert.ok(section < resources.indexOf('<fieldset'), 'and before the owner-only fieldset')
})

/* ------------------------------------------ a competition's address, as a course's */

/** A header snippet of a screen, from `{#snippet name()}` to its `{/snippet}`, without comments. */
function snippetOf(rel: string, name: string): string {
  const source = flat(code(read(rel)))
  const start = source.indexOf(`{#snippet ${name}()}`)
  assert.notEqual(start, -1, `${rel}: {#snippet ${name}()} is in place`)
  return source.slice(start, source.indexOf('{/snippet}', start))
}

/** The elements of a line with their classes, in order: what the eye takes for "the same line". */
const shape = (markup: string): string[] =>
  [...markup.matchAll(/<(\w+)\b[^>]*?\bclass="([^"]*)"/g)].map(([, tag, classes]) => `${tag}.${classes}`)

/** The address and its two links, as a course's header draws them. */
const ADDRESS = [
  'span.font-mono text-2xs text-ink',
  'span.inline-flex items-baseline gap-x-4 whitespace-nowrap',
  'a.admin-link',
  'button.admin-link',
]
/** The rule a course's line has before its tally. */
const RULE = 'span.h-3.5 w-px self-center bg-line'

/** A line's elements from its address on. */
const fromAddress = (line: string[]): string[] => line.slice(line.indexOf(ADDRESS[0]))

/** The tags of «открыть»'s and «скопировать»'s pair, from the pair's span to its end. */
function pairTags(lede: string): string[] {
  const start = lede.indexOf(`<span class="${ADDRESS[1].slice('span.'.length)}">`)
  assert.notEqual(start, -1, 'the two links are one pair')
  return [...lede.slice(start, lede.indexOf('</span>', start)).matchAll(/<(\w+)\b/g)].map(([, tag]) => tag)
}

test("a competition's console says its address the way a course's screen does", () => {
  const course = snippetOf(COURSES, 'lede')
  const live = snippetOf(LIVE, 'lede')
  // The address, then «открыть» and «скопировать» as one pair: the same
  // elements in the same classes and order on both screens. Where the line
  // wraps — a phone, a long address — the pair moves on whole; one link
  // without the other was the usual thing for a competition's short name.
  assert.deepEqual(fromAddress(shape(course)).slice(0, ADDRESS.length), ADDRESS)
  assert.deepEqual(fromAddress(shape(live)), ADDRESS, 'the console says nothing after the pair')
  for (const lede of [course, live]) assert.deepEqual(pairTags(lede), ['span', 'a', 'button'])
  // A course goes on after a rule with its tally. The console has no rule
  // at all: its state, drawn after one, did not fit beside the address at
  // 1280–1440 px and left the rule hanging at the end of the address's line.
  // The state is a line of its own instead, first, under the title.
  assert.deepEqual(fromAddress(shape(course)).slice(ADDRESS.length), [RULE, 'span.text-2xs text-muted'])
  assert.ok(!shape(live).includes(RULE), 'no rule in the console header')
  assert.match(live, /^\{#snippet lede\(\)\} <div class="flex min-w-0 basis-full flex-wrap items-center gap-x-2\.5 gap-y-1\.5"> <Badge word=\{phaseWord\(phase\)\}/)
  assert.match(live, /\{statusNote\(c, now, privatePending\)\}<\/span> <\/div> <span class="font-mono text-2xs text-ink">/)
  // The address read is the one opened, in a new tab, and the one copied whole.
  assert.match(live, /<span class="font-mono text-2xs text-ink">\{location\.host\}\{competitionPath\(c\.slug\)\}<\/span>/)
  assert.match(live, /<a class="admin-link" href=\{competitionPath\(c\.slug\)\} target="_blank" rel="noreferrer">/)
  assert.match(live, /<button type="button" class="admin-link" onclick=\{copyAddress\}>/)
  const source = flat(code(read(LIVE)))
  assert.match(source, /const link = `\$\{location\.origin\}\$\{competitionPath\(c\.slug\)\}`/)
  // A closed clipboard is answered as on the course's screen: the link in words.
  assert.match(source, /void copy\(link, 'link', \(\) => tr\('admin\.could\.not\.copy\.the\.link\.copy\.it\.manually', \{ p0: link \}\)\)/)
  assert.match(code(read(COURSES)), /tr\("admin\.could\.not\.copy\.the\.link\.copy\.it\.manually", \{ p0: text \}\)/)
  // The course's words, in both languages, with «Скопировано» for a moment after.
  for (const [locale, open, copy, done] of [
    ['ru', 'открыть', 'скопировать', 'Скопировано'],
    ['en', 'open', 'copy', 'Copied'],
  ] as const) {
    const words = localized(live, locale)
    assert.match(words, new RegExp(`rel="noreferrer"> \\{${open}\\} </a>`), `${locale}: ${open}`)
    assert.match(words, new RegExp(`\\{copied === 'link' \\? ${done} : ${copy}\\}`), `${locale}: ${copy}`)
  }
})

test('a refused copy keeps its link on screen while the feed moves, and offers no reload', () => {
  const source = flat(code(read(LIVE)))
  // The refusal has a slot of its own, not the requests' one…
  const copy = source.slice(source.indexOf('async function copy('), source.indexOf('function copyAddress('))
  assert.match(copy, /const id = c\.id copyRefusal = null try \{ await copyText\(text\) \} catch \{ if \(id === c\.id\) copyRefusal = refusal return \}/)
  assert.doesNotMatch(copy, /errorText/)
  // …which the feed's reload leaves alone. That reload runs on every push of
  // the stream (every 5 s when polling) and clears the requests' slot, so a
  // link in it went away as soon as anything happened in the competition.
  const loadFeed = source.slice(source.indexOf('async function loadFeed('), source.indexOf('async function loadBoard('))
  assert.match(loadFeed, /errorText = null/)
  assert.doesNotMatch(loadFeed, /copyRefusal/)
  // Only the next copy clears it — and another competition, whose link it no
  // longer is.
  assert.equal(source.match(/(?<!let )\bcopyRefusal = /g)?.length, 3, 'set by a copy, cleared by a copy and by a new competition')
  assert.match(source, /lateFilter = 'all' copyRefusal = null \}\)/)
  // It is said on a line of its own, without «Повторить» — that reloads the
  // feed, and copies nothing.
  assert.match(source, /\{#if copyRefused\} <p class="pt-4 text-ui text-danger" role="alert">\{copyRefused\}<\/p> \{\/if\} \{#if error\}/)
})

test('the console has no «Ссылка участникам» any more, and says the address once', () => {
  assert.equal(hasTranslation('admin.competitions.entrantLink'), false, 'the key left the catalog')
  const live = code(read(LIVE))
  assert.doesNotMatch(live, /entrantLink/)
  assert.doesNotMatch(localized(live, 'ru'), /Ссылка участникам/)
  assert.doesNotMatch(localized(live, 'en'), /Link for participants/)
  // The actions copy nothing; the eyebrow names the section, not the address.
  assert.doesNotMatch(snippetOf(LIVE, 'actions'), /copy/i)
  assert.doesNotMatch(snippetOf(LIVE, 'eyebrow'), /\/k\/|competitionPath|c\.slug/)
})

test("a draft's editor names its address, but neither opens nor copies it: /k does not serve a draft", () => {
  const lede = snippetOf(EDITOR, 'lede')
  // The face of the console's and the course's address…
  assert.equal(shape(lede)[0], shape(snippetOf(COURSES, 'lede'))[0])
  assert.match(lede, /^\{#snippet lede\(\)\} <span class="font-mono text-2xs text-ink">\{location\.host\}\{competitionPath\(c\.slug\)\}<\/span>/)
  // …with no link to a page that answers "No such competition" to everyone,
  // the teacher included (tests/competitions-phase.test.mts), but a muted
  // word on when it starts to work.
  assert.doesNotMatch(lede, /admin-link|<a\b|<button\b|copy/i)
  assert.match(lede, /\{#if draftState\} <span class="text-2xs text-muted">\{tr\('admin\.competitions\.addressWhenOpen'\)\}<\/span> \{\/if\}/)
  assert.equal(translate('ru', 'admin.competitions.addressWhenOpen'), 'заработает, когда соревнование откроется')
  assert.equal(translate('en', 'admin.competitions.addressWhenOpen'), 'works once the competition opens')
  assert.doesNotMatch(snippetOf(EDITOR, 'eyebrow'), /\/k\/|competitionPath|c\.slug/)
})
