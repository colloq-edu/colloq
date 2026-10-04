/**
 * One scale and one vocabulary for every tab of the teacher's panel.
 *
 * October 2026, the owner: "check the admin globally so sizes and fonts don't
 * jump between screens; competitions seem to have their own, very separate
 * styles". They did: the shell switched the competitions' scale on for three
 * tabs out of nine, and every screen spelled its own table header, row menu,
 * «⋯» button and search box — so a class row was 14 px beside a 16 px course
 * row, and buttons came in at 30, 32, 34, 36 and 38 px.
 *
 * Now the shell puts the scale on <main> for every tab (index.css ·
 * .competition-ui + .admin-ui), the vocabulary lives once in index.css and
 * admin/ui, and the competition screens it was lifted from use it. The tabs
 * still on their own spelling are listed in PENDING; a tab leaves the list
 * when it is converted, and the list is empty when the panel is one product.
 *
 * Read straight from the components, as in admin-phone.test.mts: a test with
 * its own copy of the rule passes forever while the file drifts away.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

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

const flat = (source: string): string => source.replace(/\s+/g, ' ')

const SCREENS = 'web/src/admin/screens'
const UI = 'web/src/admin/ui'

/** Everything drawn inside the shell's <main>. The rail (LanguageMenu) is not. */
const PANEL = [
  ...fs
    .readdirSync(path.resolve(import.meta.dirname, '..', SCREENS))
    .filter((name) => name.endsWith('.svelte'))
    .map((name) => `${SCREENS}/${name}`),
  ...fs
    .readdirSync(path.resolve(import.meta.dirname, '..', SCREENS, 'competitions'))
    .filter((name) => name.endsWith('.svelte'))
    .map((name) => `${SCREENS}/competitions/${name}`),
  ...fs
    .readdirSync(path.resolve(import.meta.dirname, '..', UI))
    .filter((name) => name.endsWith('.svelte') && name !== 'LanguageMenu.svelte')
    .map((name) => `${UI}/${name}`),
]

/**
 * The tabs not yet on the vocabulary. One per line, so converting a tab is
 * deleting its own line. Empty since October 2026: every tab speaks it, and a
 * new screen joins the check by existing.
 */
const PENDING = new Set<string>([])

/* ------------------------------------------------------------ the shell */

test('every tab reads at one scale', () => {
  const shell = flat(code(read('web/src/admin/AdminShell.svelte')))
  assert.match(shell, /<main class="competition-ui admin-ui /, 'the scale is on <main> itself')
  assert.doesNotMatch(shell, /class:competition-ui/, 'and no tab can switch it off')
  assert.doesNotMatch(shell, /reading\??:/, 'no prop picks which tabs get it')
  const screen = code(read('web/src/screens/AdminScreen.svelte'))
  assert.doesNotMatch(screen, /reading=/)
})

test('the scale lifts the two steps the competition scope leaves alone', () => {
  // Under the 16 px body a 15 px ui-lg and a 13 px code step invert a tab's
  // hierarchy; motion.css reads the variables .admin-ui sets.
  const css = read('web/src/index.css')
  const scope = css.slice(css.indexOf('.admin-ui {'), css.indexOf('}', css.indexOf('.admin-ui {')))
  assert.match(scope, /--type-ui-lg: 17px/)
  assert.match(scope, /--type-code: 15px/)
  const motion = read('web/src/admin/motion.css')
  assert.match(motion, /\.admin \.text-ui-lg \{\s*font-size: var\(--type-ui-lg, 15px\)/)
  assert.match(motion, /\.admin \.text-code \{\s*font-size: var\(--type-code, 13px\)/)
})

test('one control height: 40 on a desktop, 44 on a phone', () => {
  const css = flat(read('web/src/index.css'))
  assert.match(css, /\.admin-ui :where\( \[class~='btn'\],[^)]*\) \{ min-height: 40px; \}/)
  assert.match(css, /\.admin-ui :where\(input\[class~='field'\], select\[class~='field'\]\) \{ height: 40px;/)
  const phone = css.slice(css.indexOf('@media (max-width: 640px) { .admin-ui'))
  assert.match(phone, /min-height: 44px/)
  assert.match(phone, /height: 44px/)
})

/* ------------------------------------------------------- the vocabulary */

test('the vocabulary is defined once, in index.css', () => {
  const css = read('web/src/index.css')
  for (const name of [
    'btn-caps',
    'btn-danger',
    'btn-danger-solid',
    'admin-label',
    'admin-section',
    'admin-section-title',
    'admin-list-head',
    'admin-list-row',
    'admin-data-row',
    'admin-table',
    'admin-row-title',
    'admin-meta',
    'admin-num',
    'admin-link',
    'admin-icon-btn',
    'admin-menu',
    'admin-menu-item',
    'admin-menu-sep',
    'admin-tabs',
    'admin-tab',
    'admin-affix',
  ]) {
    assert.match(css, new RegExp(`\\n  \\.${name} \\{`), `.${name} is a shared class`)
  }
  for (const file of ['EmptyState.svelte', 'SearchField.svelte', 'AdminPage.svelte', 'Section.svelte']) {
    assert.ok(fs.existsSync(path.resolve(import.meta.dirname, '..', UI, file)), `admin/ui/${file}`)
  }
})

test('the competition screens it was lifted from speak it', () => {
  const list = flat(code(read(`${SCREENS}/Competitions.svelte`)))
  assert.match(list, /<SearchField /, 'the search is the shared field')
  assert.match(list, /class="btn-primary btn-caps /, 'the page action is the shared caps button')
  assert.match(list, /class="comp-head admin-list-head"/)
  assert.match(list, /class="comp-row admin-list-row"/)
  assert.match(list, /class="admin-icon-btn"/)
  assert.match(list, /class="row-menu admin-menu /)
  assert.match(list, /<EmptyState /)

  const live = flat(code(read(`${SCREENS}/competitions/Live.svelte`)))
  assert.match(live, /class="admin-tabs"/)
  assert.match(live, /class="admin-tab"/)
  assert.match(live, /class="btn-danger"/, 'finishing is the shared danger frame')
  assert.equal([...live.matchAll(/class="btn-danger-solid"/g)].length, 2, 'both confirmations')

  const editor = flat(code(read(`${SCREENS}/competitions/Editor.svelte`)))
  assert.match(editor, /class="admin-affix /, 'the address field is the shared affix field')

  for (const rel of [
    `${SCREENS}/Competitions.svelte`,
    `${SCREENS}/competitions/Live.svelte`,
    `${SCREENS}/competitions/Editor.svelte`,
  ]) {
    const source = code(read(rel))
    // A menu item, a column header and a size spelled out by hand are exactly
    // what drifted between tabs.
    assert.doesNotMatch(source, /MENU_ITEM/, `${rel}: a private menu item`)
    assert.doesNotMatch(source, /'text-micro font-bold uppercase tracking-caps text-muted'/, rel)
    assert.doesNotMatch(source, /\bh-\[(30|34)px\]|\bbtn[-a-z]* h-8\b/, `${rel}: a private control height`)
  }
})

test('late intake, the hidden test and the feed marks are drawn in the same vocabulary', () => {
  // October 2026: «Поздние посылки», the hidden test and the late feed came
  // after the panel became one product, and had to arrive speaking it.
  const editor = flat(code(read(`${SCREENS}/competitions/Editor.svelte`)))
  assert.match(editor, /<Section title=\{tr\('admin\.competitions\.section\.sealed'\)\}/, 'the hidden test is a section like the rest')
  assert.match(editor, /role="switch" aria-checked=\{lateSubmissions\}/, 'the late switch is a real switch')
  // The switch's row is the panel's control height, as the chips beside it.
  assert.match(editor, /<label class="flex min-h-10 [^"]*max-\[640px\]:min-h-11">/)
  assert.equal([...editor.matchAll(/class="admin-affix[ "]/g)].length, 2, 'the address and the path in data/ are both affix fields')
  assert.match(editor, /<Badge word=\{tr\('admin\.competitions\.policyRecommended'\)\} tone="positive" \/>/)
  assert.match(editor, /<Badge word=\{tr\('admin\.competitions\.exampleBadge'\)\} tone="accent" \/>/)
  const live = flat(code(read(`${SCREENS}/competitions/Live.svelte`)))
  assert.match(live, /<Choice options=\{\[/, 'the late filter is the shared chip row')
  // One mark for a late submission wherever it stands: the feed, a running slot, the waiting list.
  assert.equal(
    [...live.matchAll(/<Badge word=\{tr\('admin\.competitions\.lateBadge'\)\} tone="brand" form="outline" \/>/g)].length,
    3,
  )
})

test('a state word wears one tone on every tab', () => {
  // «ЧЕРНОВИК» was amber on Competitions and a grey frame on Classes, and
  // «НЕ СОБРАНО» amber in the competition editor but grey on Environments:
  // one word, two looks, on neighbouring tabs. The competitions' table
  // (admin/competitions.ts · stateTone) is the one the others follow.
  const competitions = code(read('web/src/admin/competitions.ts'))
  assert.match(competitions, /state === 'live' \? 'accent' : state === 'draft' \? 'warning' : 'neutral'/)
  const seminars = flat(code(read(`${SCREENS}/Seminars.svelte`)))
  assert.match(seminars, /<Badge word=\{tr\("admin\.draft"\)\} tone="warning" \/>/, 'a class draft is amber')
  assert.match(seminars, /<Badge word=\{tr\("admin\.finished"\)\} tone="neutral" \/>/, 'a finished class is neutral')
  assert.match(seminars, /<Badge word=\{tr\("admin\.live\.990"\)\} tone="accent" \/>/, 'a live class is accent')
  const environments = flat(code(read(`${SCREENS}/Environments.svelte`)))
  assert.match(environments, /<Badge word=\{tr\("admin\.not\.built"\)\} tone="warning"/, 'an unbuilt environment is amber')
  const editor = flat(code(read(`${SCREENS}/competitions/Editor.svelte`)))
  assert.match(editor, /tone=\{chosenEnvironment\.state === 'ready' \? 'positive' : 'warning'\}/)
})

test('the room rules read at the panel scale inside the panel, and only there', () => {
  // RoomRulesRows draws the rules in the room's pult as well, at a cursor's
  // 32 px; in NewSeminar and the Seminars rules window it stands beside 40 px
  // fields and 16 px chips. The panel's size is keyed to .admin-ui, so the
  // room keeps its own.
  const rules = flat(code(read('web/src/components/RoomRulesRows.svelte')))
  assert.match(rules, /\.rule-seg \{ height: 32px;/, 'the room keeps its measure')
  assert.match(rules, /:global\(\.admin-ui\) \.rule-seg \{ height: 40px; [^}]*font-size: 16px;/)
  assert.match(rules, /:global\(\.admin-ui\) \.rule-num \{ [^}]*height: 40px; [^}]*font-size: 15px;/)
  assert.match(rules, /:global\(\.admin-ui\) \.rule-pick \{ height: 40px;/)
  const phone = rules.slice(rules.lastIndexOf('@media (max-width: 640px)'))
  assert.match(phone, /:global\(\.admin-ui\) \.rule-seg, :global\(\.admin-ui\) \.rule-num, :global\(\.admin-ui\) \.rule-pick \{ height: 44px;/)
  // The chosen segment keeps its light label under the pointer: the plain
  // hover rule is one pseudo-class heavier than `.rule-seg-on:hover` was.
  assert.match(rules, /\.rule-seg-on:hover:not\(:disabled\) \{ color: rgb\(var\(--primary-ink\)\);/)
})

/* -------------------------------------------------- off-scale spellings */

/**
 * Steps that are not on the panel's scale. `ui-lg` and `code` are lifted by
 * .admin-ui only so an unconverted tab does not invert; converted markup
 * says `ui` / `2xs` / `title` instead. Pixel sizes bypass the scale outright.
 * `tracking-label` and `tracking-section` are the workspace's caps; the
 * panel's label voice is `tracking-caps` (.admin-label).
 */
const OFF_SCALE: [RegExp, string][] = [
  [/(?<![-\w])text-ui-lg(?! leading-none)/, 'text-ui-lg'],
  [/(?<![-\w])text-code(-lg)?(?![-\w])/, 'text-code'],
  [/(?<![-\w])text-\[\d+px\]/, 'a pixel font size'],
  [/(?<![-\w])tracking-(label|section)(?![-\w])/, 'workspace caps tracking'],
]

test('no converted tab spells a size off the scale', () => {
  for (const rel of PANEL) {
    if (PENDING.has(rel)) continue
    const source = code(read(rel))
    for (const [pattern, what] of OFF_SCALE) {
      assert.doesNotMatch(source, pattern, `${rel}: ${what}`)
    }
  }
})

test('the pending list names only files that exist', () => {
  for (const rel of PENDING) assert.ok(PANEL.includes(rel), `${rel} is not a panel file`)
})
