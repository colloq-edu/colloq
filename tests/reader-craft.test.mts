/**
 * The public pages are the only Colloq addresses that get opened from a phone,
 * from home, a week after the class. And they are also the only place in the
 * product with no socket, no kernel and few pure functions: most of it is
 * markup, and markup breaks quietly and reverts with one line.
 *
 * What is checked is what can be checked without a browser: that course rows
 * are real links, that the class page has tabs a phone can scroll and a
 * table of contents that pushes anchors, that the tab title is not "Colloq",
 * that the addresses are the ones read out loud, and that a clipboard refusal
 * is visible. The date rules live in course-now.test.mts; layout and the
 * accessibility tree live in scripts/ui-check.mts.
 *
 * The same technique as in `panels-craft.test.mts`, and for the same reason: a
 * test with its own copy of the rule passes forever while the file drifts away.
 */
import fs from 'node:fs'
import { hasTranslation, translate } from '../shared/i18n.js'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup and code without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const SCREEN = code(read('web/src/screens/ReaderScreen.svelte'))
const COURSE = code(read('web/src/components/reader/CoursePage.svelte'))
const CLASS = code(read('web/src/components/reader/ClassPage.svelte'))
const OUTLINE = code(read('web/src/components/reader/Outline.svelte'))
const MATERIALS = code(read('web/src/components/reader/MaterialList.svelte'))
const LINKS = code(read('web/src/components/reader/MaterialLinks.svelte'))
const BAR = code(read('web/src/components/reader/ReaderBar.svelte'))
const NOTEBOOK = code(read('web/src/components/reader/PublicNotebook.svelte'))
const APP = code(read('web/src/App.svelte'))

/* ------------------------------------------------------------ course rows */

test('course rows are real links, and a plain click still navigates in place', () => {
  /*
   * The rows were <button>s calling onnavigate: no long-press "copy link" on
   * a phone, no middle click, no "open in a new tab", and a row a student
   * wanted to send a classmate could not be sent.
   */
  assert.equal(
    fs.existsSync(path.resolve(import.meta.dirname, '..', 'web/src/components/reader/CourseList.svelte')),
    false,
    'the old button list is back',
  )
  assert.match(COURSE, /<a\s[^>]*\{href\}[\s\S]*?onclick=\{\(event\) => follow\(event, href\)\}/)
  assert.doesNotMatch(COURSE, /<button[^>]*onclick=\{\(\) => onnavigate/, 'a row is a button again')
  assert.match(COURSE, /if \(!plainClick\(event\)\) return/, 'a ctrl-click no longer opens a new tab')
  const links = code(read('web/src/components/reader/links.ts'))
  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey']) assert.match(links, new RegExp(key))
})

test('a course row has no right-aligned meta that squeezes the title', () => {
  /*
   * The date and the step count sat in a shrink-0 column on the right: on a
   * 390 phone the title went one word per line. Rows are two lines now.
   */
  const rows = COURSE.slice(COURSE.indexOf('{#snippet rowBody'), COURSE.indexOf('{/snippet}', COURSE.indexOf('{#snippet rowBody')))
  assert.doesNotMatch(rows, /text-right/, 'a right-aligned meta column is back in the row')
  assert.doesNotMatch(rows, /max-w-\[45%\]/)
})

test('the step words and the disclaimer box are retired, not just unused', () => {
  /*
   * «· 1 шаг», «· опубликован», «Шаги занятия» and the three-line box above
   * the notebook: the class day and one footer line replaced them, and a key
   * left in the catalog is a key someone prints again.
   */
  for (const key of ['room.ui.709', 'room.ui.711', 'room.ui.713', 'room.ui.714', 'room.ui.715',
    'room.ui.868', 'room.ui.869', 'room.ui.871', 'room.ui.872', 'room.ui.873', 'room.ui.882']) {
    assert.equal(hasTranslation(key), false, `${key} is still in the catalog`)
  }
})

test('materials go where their kind belongs', () => {
  const links = code(read('web/src/components/reader/links.ts'))
  assert.match(links, /kind === 'notebook'\) return pageHref\(address, m\.key\)/)
  assert.match(links, /kind === 'pdf'\) return `\/api\/p\/\$\{address\}\/m\/\$\{m\.key\}\/open`/)
  assert.match(links, /return downloadHref\(address, m\.key\)/)
  // A PDF opens in a tab of its own; anything that is not a notebook or a PDF downloads.
  for (const list of [LINKS, MATERIALS]) {
    assert.match(list, /target=\{m\.kind === 'pdf' \? '_blank' : undefined\}/)
    assert.match(list, /rel=\{m\.kind === 'pdf' \? 'noopener' : undefined\}/)
  }
})

/* -------------------------------------------------------------- class page */

test('the class page has no step navigation', () => {
  assert.doesNotMatch(CLASS + SCREEN, /aria-current=\{on \? 'step'/, 'a step rail is back')
  assert.doesNotMatch(CLASS + SCREEN, /api\.step\(|\/step\//, 'the reader asks for steps again')
  assert.doesNotMatch(read('web/src/lib/api.ts'), /\/step\//)
})

test('notebook tabs mark the open one and live in a sticky strip that scrolls sideways', () => {
  const nav = (CLASS.match(/<nav\s[^>]*aria-label=\{tr\('room\.page\.tabs'\)\}[\s\S]*?>/) ?? [''])[0]
  assert.ok(nav, 'there is no tab strip')
  assert.match(nav, /overflow-x-auto/, 'five notebooks in one line will not fit without scrolling')
  assert.match(CLASS, /sticky top-0/, 'once down the notebook, there is nothing to switch tabs with')
  assert.match(CLASS, /aria-current=\{on \? 'page' : undefined\}/, 'the open tab is not announced')
  assert.match(CLASS, /scrollIntoView\(\{ block: 'nearest', inline: 'center' \}\)/)
  // Tabs only when there is something to switch between: a legacy page has one notebook.
  assert.match(CLASS, /const tabbed = \$derived\(notebooks\.length >= 2\)/)
})

test('a tab switch does not reload the page, and keeps the reader where it is', () => {
  /*
   * The router builds a new route object on every address change, including
   * `/p/x/lecture` → `/p/x/seminar`. An effect reading `publication?.id`
   * depends on the object, and every tab switch would cost a GET /api/p/:id.
   */
  assert.match(SCREEN, /const pubId = \$derived\(/, 'the page id is again not split out')
  const effects = SCREEN.match(/\$effect\(\(\) => \{[\s\S]*?\n  \}\)/g) ?? []
  assert.ok(effects.length > 0, 'no effects found in the screen: the test is looking in the wrong place')
  for (const effect of effects) {
    assert.doesNotMatch(effect, /publication\?\.id/, 'an effect depends on the route object again')
  }
  // The {#key} holds the page by the handle it was opened under; a tab of the same page does not jump to the top.
  assert.match(
    APP,
    /\{#key courseId \? `c:\$\{courseId\}` : `p:\$\{openedAs\[publicSeminar\?\.id \?\? ''\] \?\? publicSeminar\?\.id \?\? ''\}`\}/,
  )
  assert.match(APP, /const samePage = from !== null && to !== null && from\.id === to\.id/)
  // Notebook bodies are fetched per tab and kept for the visit.
  assert.match(CLASS, /const cache = new Map<string, NotebookBody>\(\)/)
  assert.match(CLASS, /api\s*\.notebook\(id, key\)/)
})

test('a legacy step address becomes the page address', () => {
  assert.match(APP, /if \(publicSeminar\?\.legacy\) replace\(`\/p\/\$\{publicSeminar\.id\}`\)/)
  assert.match(APP, /history\.replaceState\(/)
})

test('an id or a former name in the address becomes the page’s own, without a second page load', () => {
  /*
   * Tabs link to the canonical address, so on /p/<id> the first tab switch
   * changed the handle in App's {#key}: the splash, a second GET /api/p and a
   * jump to the top. The reader now respells the address once the page says
   * what it is, and App keeps the key by the handle the page was opened under.
   */
  assert.match(SCREEN, /if \(id !== body\.page\.address\) onreplace\(pageHref\(body\.page\.address, materialKey\)\)/)
  const replace = APP.slice(APP.indexOf('function replace('), APP.indexOf('function knownRoom'))
  assert.match(replace, /openedAs = \{ \.\.\.openedAs, \[to\.id\]: openedAs\[from\.id\] \?\? from\.id \}/)
  // The cell in the hash survives the respelling, and the route never sees it.
  assert.match(replace, /history\.replaceState\(history\.state, '', next \+ location\.hash\)/)
  assert.match(replace, /path = next/)
  // The same page under its new spelling is not fetched a second time.
  assert.match(SCREEN, /if \(run === fetchedAttempt && known && \(known\.address === id \|\| known\.id === id\)\) return/)
})

test('a tab that vanished in a rebuild reloads the page list, and «Открыть первый» never loops', () => {
  /*
   * The page JSON listed the tab, the teacher republished without it, and the
   * 404 replaced the reader with «Открыть первый» pointing at the same key:
   * navigating to the same path did nothing, and the tabs were hidden.
   */
  assert.match(CLASS, /failedKey = key\s+if \(reloadedFor !== key\) \{\s+reloadedFor = key\s+onreload\(\)/)
  assert.match(CLASS, /const firstKey = \$derived\(notebooks\.find\(\(m\) => m\.key !== failedKey\)\?\.key \?\? null\)/)
  assert.match(CLASS, /if \(firstKey !== null\) onnavigate\(firstHref\)\s+else location\.assign\(firstHref\)/)
  assert.match(SCREEN, /onreload=\{\(\) => \(attempt \+= 1\)\}/)
})

test('the outline pushes the cell anchor and follows the reading', () => {
  assert.match(OUTLINE, /href=\{`#\$\{entry\.id\}`\}/, 'outline entries are not links to the cell')
  assert.match(OUTLINE, /history\.pushState\(history\.state, '', `#\$\{id\}`\)/)
  assert.match(NOTEBOOK, /<div id=\{cell\.id\}/, 'cells have no anchors to jump to')
  assert.match(NOTEBOOK, /scroll-mt-/, 'a jumped-to heading hides under the sticky strip')
  // The current section is tracked by an observer on the document, not a pane.
  assert.match(CLASS, /new IntersectionObserver\(pick, \{ rootMargin: '0px 0px -70% 0px' \}\)/)
  assert.doesNotMatch(CLASS, /IntersectionObserver\([^)]*root:/)
})

test('long code folds, and the copy button still copies the whole cell', () => {
  assert.match(NOTEBOOK, /const FOLD_OVER = 30/)
  assert.match(NOTEBOOK, /const FOLD_TO = 14/)
  assert.match(NOTEBOOK, /copyText\(cell\.source\)/, 'copy took the folded text')
  assert.match(NOTEBOOK, /tr\('room\.page\.showMore', \{ count: shown\.hidden \}\)/)
})

test('images on a class page load as they come near', () => {
  assert.match(NOTEBOOK, /<CellOutputs outputs=\{cell\.outputs\.map\(blobbed\)\} lazy \/>/)
  assert.match(
    NOTEBOOK,
    /render\.markdown\(noted\(cell\.source\), \{ lazyImages: true \}\)/,
    'note images still load all at once',
  )
  const outputs = code(read('web/src/components/notebook/CellOutputs.svelte'))
  assert.match(outputs, /loading=\{lazy \? 'lazy' : undefined\}/)
})

test('sanitized note HTML is never rewritten as a string', () => {
  /*
   * A regex that added loading="lazy" to the serialized markup was stored XSS:
   * browsers before mid-2025 do not escape `<` inside attribute values on
   * serialization, so `![<img onerror=…](x)` came out as alt="<img onerror=…",
   * the regex put a quote inside alt, and {@html} re-parsed a live onerror.
   * The attribute goes on the DOM nodes inside markdown(), before innerHTML.
   */
  assert.doesNotMatch(NOTEBOOK, /\.replace\(\s*\/<img/, 'a regex over sanitized HTML is back')
  assert.doesNotMatch(NOTEBOOK, /lazyImages\(/)
  const render = code(read('web/src/lib/render.svelte.ts'))
  const markdown = render.slice(render.indexOf('markdown(source'), render.indexOf('ansi(text)'))
  const lazy = markdown.indexOf("img.setAttribute('loading', 'lazy')")
  assert.ok(lazy > 0, 'markdown() no longer sets loading on the image nodes')
  assert.ok(lazy < markdown.indexOf('return holder.innerHTML'), 'the attribute is set after serializing')
  assert.ok(lazy > markdown.indexOf('DOMPurify.sanitize('), 'the attribute is set before sanitizing')
})

test('a long material name wraps instead of scrolling the phone page sideways', () => {
  /*
   * Names default to room paths, and `data/sber_real_estate_train_2015.parquet`
   * has no break point: on a 390px phone it ran past the gutter. `anywhere`
   * rather than break-word, because only it shrinks the flex min-content width.
   */
  const name = MATERIALS.slice(MATERIALS.indexOf('href={materialHref(page.address, m)}'))
  assert.match(name.slice(0, name.indexOf('</a>')), /\[overflow-wrap:anywhere\]/)
  const link = LINKS.slice(LINKS.indexOf('href={materialHref(address, m)}'))
  assert.match(link.slice(0, link.indexOf('{m.name}')), /\[overflow-wrap:anywhere\]/)
})

test('a download button never sits inside the link it is next to', () => {
  /*
   * The name is a link stretched over the row and the download is a sibling
   * above it: a link inside a link is invalid markup and a tap on the icon
   * would open the notebook instead of downloading it.
   */
  assert.match(MATERIALS, /after:absolute after:inset-0/)
  assert.match(MATERIALS, /relative z-10/)
  assert.match(MATERIALS, /tr\('room\.page\.downloadNotebook', \{ name: m\.name \}\)/)
})

/* ---------------------------------------------------------- theme and title */

test('both public pages carry the theme switch', () => {
  assert.match(BAR, /import ThemeSwitch from '@\/components\/ui\/ThemeSwitch\.svelte'/)
  assert.match(BAR, /<ThemeSwitch \/>/)
  assert.match(COURSE, /<ReaderBar /)
  assert.match(CLASS, /<ReaderBar/)
})

test('the tab of a course or a class carries its own name', () => {
  /*
   * The course page is the only Colloq address a person bookmarks, and a class
   * page is the one sent around in chats. In bookmarks, the history and the
   * tab switcher every one of them was called "Colloq".
   */
  assert.match(SCREEN, /document\.title = named === null \? 'Colloq' : `\$\{named\} · Colloq`/)
  assert.match(SCREEN, /`\$\{ordinal\(page\.n\)\} · \$\{page\.title\}`/, 'the class number is not in the title')
  assert.match(
    SCREEN,
    /document\.title = 'Colloq'/,
    'the title is not restored on exit: the page name would stay hanging over the room',
  )
})

/* ------------------------------------------------------------ the addresses */

test('the addresses are the ones read out loud: by name, not by id', () => {
  /*
   * The panel copies and reads out `/c/<slug>`; the reader linked up to the
   * course by its eight random letters.
   */
  assert.match(COURSE, /const coursePath = \$derived\(`\/c\/\$\{course\.slug \?\? course\.id\}`\)/)
  assert.match(CLASS, /`\/c\/\$\{page\.course\.slug \?\? page\.course\.id\}`/)
  assert.doesNotMatch(CLASS + SCREEN, /\/c\/\$\{[a-z!.]*course!?\.id\}/, 'the way up is by id again')
})

/* ------------------------------------------------- a clipboard refusal */

test('a clipboard refusal is visible on screen, not in the console', () => {
  /*
   * `copyText` throws when there is no permission or execCommand refused: on a
   * department's http instance and in a strict browser the "copy" button did
   * nothing — no checkmark, no word, the rejection went to unhandledrejection.
   */
  assert.match(NOTEBOOK, /catch \{/, 'copying again has no refusal handling')
  assert.match(NOTEBOOK, /refused/, 'there is no "not copied" state')
  assert.match(NOTEBOOK, /tr\('room\.ui\.731'\)/, 'the person is told nothing and offered no way out')
  const copy = code(read('web/src/components/reader/CopyLink.svelte'))
  assert.match(copy, /tr\('room\.course\.copyFailed'\)/, 'the page link copy fails silently')
})

test('the cell button has press feedback and a finger-sized target', () => {
  const button = (NOTEBOOK.match(/<button[\s\S]*?<\/button>/) ?? [''])[0]
  assert.match(button, /\bpress\b/, 'pressable without .press: the only proof that the click was heard')
  const size = /h-\[(\d+)px\] w-\[(\d+)px\]/.exec(button)
  assert.ok(size, 'the copy button size is no longer explicit')
  assert.ok(
    Number(size[1]) >= 24 && Number(size[2]) >= 24,
    `a ${size[1]}×${size[2]} px target on a page that is opened from a phone`,
  )
})

/* ----------------------------------------------------------- dead code */

test('a class no stylesheet knows is not applied', () => {
  /*
   * `documentElement.classList.add('reader')` promised a "reader mode", but the
   * project has not a single rule for `.reader`: the next person to look for why
   * the public page looks different would be looking for something that does not exist.
   */
  assert.doesNotMatch(SCREEN, /classList\.add\('reader'\)/, 'the dead class is back')
  const css = read('web/src/index.css')
  assert.doesNotMatch(css, /(^|[\s,{])(html)?\.reader\b/m, 'a rule for .reader appeared: then bring the class back too')
})

/* ---------------------------------------------------------- the room door */

const DOOR = code(read('web/src/components/reader/RoomDoor.svelte'))
const PUBLISH_TYPES = read('shared/publish.ts')

/** The body of one exported interface of shared/publish.ts, braces included. */
function iface(name: string): string {
  const start = PUBLISH_TYPES.indexOf(`export interface ${name} `)
  assert.ok(start >= 0, `${name} is gone from shared/publish.ts`)
  let depth = 0
  for (let i = PUBLISH_TYPES.indexOf('{', start); i < PUBLISH_TYPES.length; i++) {
    if (PUBLISH_TYPES[i] === '{') depth++
    if (PUBLISH_TYPES[i] === '}' && --depth === 0) return PUBLISH_TYPES.slice(start, i + 1)
  }
  throw new Error(`${name} never closes`)
}

test('the public JSON types have no field a room id could ride in', () => {
  /*
   * The room id is the right to write in the room, and the room shows names
   * and oracle questions: no type the public GETs answer with may grow a
   * field for it. The door answer (RoomDoor) is the one place a room path
   * reaches a reader, and only from a POST that proved who asks.
   */
  const publicTypes = ['PublicPage', 'PublicClass', 'PublicCourseView', 'PublicMaterial', 'PublicNeighbor']
  for (const name of publicTypes) {
    const fields = iface(name).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    const roomField = /\b(sessionId|roomId|room|roomPath|roomAccess|door)\??:/
    assert.doesNotMatch(fields, roomField, `${name} grew a room field`)
  }
  assert.match(iface('RoomDoor'), /room: \{ path: string; live: boolean \} \| null/)
  // The reader never builds a room address from anything on the page.
  assert.doesNotMatch(CLASS + COURSE + DOOR, /`\/s\/\$\{/, 'a room path is assembled on the client')
})

test('the class page asks the door once, with this browser\'s keys, and draws what it says', () => {
  assert.match(CLASS, /import \{ storedTokens \} from '@\/lib\/identity'/)
  assert.match(CLASS, /api\s*\.roomDoor\(id, storedTokens\(MAX_DOOR_TOKENS\)\)/)
  assert.match(CLASS, /if \(page\.state !== 'published'\) return/, 'a withdrawn page still knocks')
  // Desktop: a block in the rail under the materials; phone: a row under the archive.
  const rail = CLASS.slice(CLASS.indexOf('<aside'), CLASS.indexOf('</aside>'))
  assert.match(rail, /<MaterialList [^\n]*\/>\s*\{#if door\}<RoomDoor \{door\} wide \/>\{\/if\}/)
  assert.match(
    CLASS,
    /<MaterialList [^\n]*wide=\{false\}[^\n]*\/>\s*\{#if door\}<RoomDoor \{door\} wide=\{false\} \/>\{\/if\}/,
  )

  // The way in is a plain link to the path the server gave, in this tab.
  assert.match(DOOR, /href=\{room\.path\}/)
  assert.doesNotMatch(DOOR, /target=/, 'the room opens in another tab')
  // Who you are to the room, or what it lets you do; the locked sentence for a stranger.
  for (const key of ['room.door.member', 'room.door.staff', 'room.door.readOnly', 'room.door.locked',
    'room.door.finished', 'room.door.open', 'room.door.names', 'room.door.go', 'room.door.rowNote']) {
    assert.match(DOOR, new RegExp(`tr\\('${key.replace(/\./g, '\\.')}'\\)`), key)
  }
  assert.match(DOOR, /const locked = \$derived\(room === null && door\.access === 'members'\)/)
  // No room and no promise: 'none' (or a deleted room) draws nothing.
  assert.match(DOOR, /\{#if wide && \(room \|\| locked\)\}/)
  assert.doesNotMatch(DOOR, />[^<{]*[А-Яа-яЁё][^<{]*</, 'Russian text written into the template')
})

test('the course page offers the room on the day of the class, while it is on', () => {
  assert.match(COURSE, /api\s*\.courseRoomDoor\(id, key, storedTokens\(MAX_DOOR_TOKENS\)\)/)
  assert.match(COURSE, /up\.row\.state === 'room' \|\| up\.row\.state === 'page' \? up\.row\.key : null/)
  assert.match(COURSE, /const liveRoom = \$derived\(door\?\.room\?\.live \? door\.room : null\)/)
  assert.match(COURSE, /\{@const live = up\.kind === 'today' \? liveRoom : null\}/)
  assert.match(COURSE, /tr\('room\.course\.todayLive', \{ day: shortDay\(up\.row\.day\) \}\)/)
  const from = COURSE.indexOf('{#if live}\n')
  const block = COURSE.slice(from, COURSE.indexOf('{/if}', from))
  assert.match(block, /href=\{live\.path\}/)
  assert.match(block, /bg-brand/, 'the way in is not the filled button of the artboard')
  assert.match(block, /tr\('room\.course\.enter'\)/)
})

test('the browser offers its room keys newest first, capped at the door\'s limit', async () => {
  const store = new Map<string, string>()
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true })
  try {
    const { storedTokens } = await import('../web/src/lib/identity.js')
    const { MAX_DOOR_TOKENS } = await import('../shared/publish.js')
    const minted = (iat: number) =>
      `${Buffer.from(JSON.stringify({ sessionId: 's', participantId: 'p', iat })).toString('base64url')}.s`
    const map: Record<string, { token: string }> = {
      old: { token: minted(1_000) },
      newest: { token: minted(3_000) },
      middle: { token: minted(2_000) },
      broken: { token: 'no-payload' },
      empty: { token: '' },
    }
    store.set('colloq.identity.v1', JSON.stringify(map))
    const { newest, middle, old } = map
    assert.deepEqual(storedTokens(), [newest.token, middle.token, old.token, 'no-payload'])
    assert.deepEqual(storedTokens(2), [map.newest.token, map.middle.token])

    const many: Record<string, { token: string }> = {}
    for (let i = 0; i < MAX_DOOR_TOKENS + 10; i++) many[`r${i}`] = { token: minted(i) }
    store.set('colloq.identity.v1', JSON.stringify(many))
    const sent = storedTokens()
    assert.equal(sent.length, MAX_DOOR_TOKENS, 'the default cap is not the server\'s')
    assert.equal(sent[0], many[`r${MAX_DOOR_TOKENS + 9}`].token)

    store.set('colloq.identity.v1', '{not json')
    assert.deepEqual(storedTokens(), [])
  } finally {
    if (real) Object.defineProperty(globalThis, 'localStorage', real)
    else delete (globalThis as { localStorage?: unknown }).localStorage
  }
})

test('the door calls go where the server listens, with nothing but the keys', async () => {
  const seen: { url: string; init?: RequestInit }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    const door = { access: 'members', member: false, staff: false, room: null }
    return new Response(JSON.stringify(door), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const { api } = await import('../web/src/lib/api.js')
    await api.roomDoor('ml-strong-04', ['t1', 't2'])
    await api.courseRoomDoor('ml-strong', 'r0000004', ['t1'])
  } finally {
    globalThis.fetch = real
  }
  assert.equal(seen[0].url, '/api/p/ml-strong-04/room')
  assert.equal(seen[0].init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { tokens: ['t1', 't2'] })
  assert.equal(seen[1].url, '/api/c/ml-strong/room')
  assert.deepEqual(JSON.parse(String(seen[1].init?.body)), { key: 'r0000004', tokens: ['t1'] })
})

test('every word of the door exists in both languages', () => {
  for (const key of ['room.door.title', 'room.door.member', 'room.door.staff', 'room.door.readOnly',
    'room.door.live', 'room.door.about', 'room.door.go', 'room.door.finished', 'room.door.open',
    'room.door.names', 'room.door.locked', 'room.door.staffMembers', 'room.door.staffAnyone',
    'room.door.staffNone', 'room.door.rowNote', 'room.door.rowLocked', 'room.course.todayLive',
    'room.course.enter']) {
    assert.ok(hasTranslation(key), `${key} is not in the catalog`)
    assert.notEqual(translate('ru', key), key, `${key} has no Russian`)
    assert.notEqual(translate('en', key), key, `${key} has no English`)
  }
})

/* ------------------------------------------------------ small honesty fixes */

test('a notebook nobody ran is not «с результатами», and its cells say no «не запускалась»', () => {
  assert.match(
    CLASS,
    /\(active\.outputs \?\? 0\) > 0\s*\? tr\('room\.page\.ipynb', \{ file: baseOf\(active\.path\) \}\)\s*: baseOf\(active\.path\)/,
  )
  assert.match(NOTEBOOK, /\{#if cell\.execCount !== null \|\| cell\.outputs\.length > 0\}/)
  assert.doesNotMatch(NOTEBOOK, /room\.ui\.736/, 'the never-ran footer is back on the page')
  assert.equal(hasTranslation('room.ui.736'), false, 'a retired key is still in the catalog')
  // The room's own cell keeps its own words: only the page dropped the footer.
  assert.match(code(read('web/src/components/notebook/CellView.svelte')), /execCount/)
})

test('«обновлено» is the server\'s day, not the browser\'s zone', () => {
  assert.match(CLASS, /const on = page\.updatedOn/)
  assert.doesNotMatch(CLASS, /resolvedOptions\(\)\.timeZone/, 'the browser zone decides the day')
  assert.match(iface('PublicPage'), /\n  updatedOn: string\n/, 'updatedOn is optional again')
})
