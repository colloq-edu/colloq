/**
 * The panel on a phone: the running-class badge, the lists and the toggles.
 *
 * 19 Sep 2026, after a seminar: "the general list of classes, that live
 * badge there breaks on the phone". It did not break by accident but by the
 * way the markup is built, and that is why it is checked here rather than
 * by eye at the next seminar.
 *
 * Four neighbouring screens where the same thing turned up are checked as
 * well: environments (the name squeezed to zero, the GPU badge on top of
 * the state, an action 293px wide), teachers (a registry with a 600px
 * minimum and a paragraph one word wide next to an unshrinkable button), the
 * rules toggle (three `nowrap` segments = 311px) and the "where the notebook
 * comes from" doors (a 182px ceiling from a row that does not exist on a
 * phone).
 *
 * The badge is a row of three parts, and the button group on the right is
 * `shrink-0`: the row can wrap but cannot shrink. Measured on the test bench
 * with a 390px screen: the group took 84…430px, that is, "Open" was half
 * past the edge, and there was no way to press it.
 *
 * The list is a table with six columns and a 600px minimum: at 390, past the
 * edge were the date, "joined", the state and the actions button, and with
 * it "Rules", "Archive" and "Delete". A box with its own sideways scroll
 * shows in no way that it scrolls.
 *
 * Both fixes use one and the same device: `max-[640px]:` on top of the
 * former classes. The former classes are not touched by any rule, so the
 * desktop stays exactly as it was, and the phone gets a column and cards. A
 * second markup for the phone would be a second list of actions, and one
 * day one of them would fall behind the other, and this menu holds
 * "Delete".
 *
 * It is read straight from the components, as in `panels-craft.test.mts`: a
 * test with its own copy of the rule passes forever while the file drifts
 * away.
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

/** Line breaks are a matter of formatting, not meaning. */
const flat = (source: string): string => source.replace(/\s+/g, ' ')

const SEMINARS = 'web/src/admin/screens/Seminars.svelte'
const PAGE = 'web/src/admin/ui/AdminPage.svelte'
const ENVIRONMENTS = 'web/src/admin/screens/Environments.svelte'
const TEACHERS = 'web/src/admin/screens/Teachers.svelte'
const RULES = 'web/src/components/RoomRulesRows.svelte'
const NEW_SEMINAR = 'web/src/admin/screens/NewSeminar.svelte'

const seminars = flat(code(read(SEMINARS)))
const page = flat(code(read(PAGE)))
const environments = flat(code(read(ENVIRONMENTS)))
const teachers = flat(code(read(TEACHERS)))
const rules = flat(code(read(RULES)))
const newSeminar = flat(code(read(NEW_SEMINAR)))

/**
 * The pixels that measure the first line of a card.
 *
 * One measure for three screens: the space for the menu button is
 * subtracted from the width of the title, and what is subtracted must match
 * what the button takes. The numbers are written in Tailwind steps (`w-11`
 * is 44px), so they are computed rather than copied into the test.
 */
const step = (n: string): number => Number(n) * 4

/** The whole "running now" badge, from its `{#each}` to the end of `</section>`. */
function plate(): string {
  const start = seminars.indexOf('{#each live as seminar')
  assert.notEqual(start, -1, 'the running classes badge is in place')
  const end = seminars.indexOf('</section>', start)
  assert.notEqual(end, -1, 'the badge has an end')
  return seminars.slice(start, end)
}

/** A row of the classes table, from its `{#each}` to the closing `</tr>`. */
function row(): string {
  const start = seminars.indexOf('{#each shown as seminar')
  assert.notEqual(start, -1, 'the list rows are in place')
  const end = seminars.indexOf('</tr>', start)
  assert.notEqual(end, -1, 'the row has an end')
  return seminars.slice(start, end)
}

/* -------------------------------------------------------------- badge */

test('below 640 the running-class badge folds into a column', () => {
  const live = plate()
  assert.match(live, /max-\[640px\]:flex-col/, 'the row becomes a column')
  // Otherwise the parts stay as wide as their content and huddle against the left edge.
  assert.match(live, /max-\[640px\]:items-stretch/, 'each part takes the full width')
  // 74px was not a floor but a ceiling, exactly as long as the row fitted.
  assert.match(live, /max-\[640px\]:min-h-0/, 'the badge height stops being fixed')
})

test('the badge actions row takes the whole line and does not slide past the edge', () => {
  const live = plate()
  // `margin-left: auto` on an item of a column flex cancels the stretch and
  // pushes the row to the right edge: exactly the breakage being fixed.
  assert.match(live, /max-\[640px\]:ml-0/, 'the push to the right is removed')
  // The address takes everything "Open" leaves and shrinks with an ellipsis.
  assert.match(live, /max-\[640px\]:flex-1/, 'the address button stretches')
  assert.match(live, /max-\[640px\]:min-w-0/, 'and can become narrower than its content')
  assert.match(live, /max-\[640px\]:truncate/, 'the address is truncated instead of bursting the line')
  // The host is superfluous on a phone: the panel is open on that very host,
  // and in a 278px line it eats exactly the space where the room id stands.
  assert.match(live, /max-\[640px\]:hidden[^"]*">\{hostPathOf\(seminar\)\}/, 'the host goes away')
  assert.match(live, /\{pathOf\(seminar\)\}/, '/s/… stays')
})

test('the badge is pressed with a finger: both targets are 44px', () => {
  const live = plate()
  const tall = [...live.matchAll(/max-\[640px\]:h-11/g)]
  assert.equal(tall.length, 2, 'both the address button and "Open" are 44px tall')
})

test('a long title in the badge reads as two lines, not as a third of one', () => {
  const live = plate()
  assert.match(live, /max-\[640px\]:line-clamp-2/, 'two lines with truncation')
  // `truncate` holds `white-space: nowrap`, and without this class the
  // two-line clamp stays one line: the rule quietly does nothing.
  assert.match(live, /max-\[640px\]:whitespace-normal/, 'and word wrapping is allowed')
})

test('the badge margins and the page margins are one number', () => {
  // The badge sticks out of the text column ON PURPOSE, across the full
  // screen width, and does so with a negative margin. Once these two numbers
  // diverge from the page margin, the badge sticks out past the edge on a
  // phone and falls short of it on a desktop.
  assert.match(plate(), /-mx-7/, 'the badge stretches over the page margins')
  assert.match(page, /flex-1 overflow-auto px-7/, 'and the page margins are 28px')
  assert.doesNotMatch(
    page,
    /max-\[\d+px\]:px-\d/,
    'and they are the same for all widths: a margin of its own on a phone would misalign the badge',
  )
})

/* ---------------------------------------------------------------- list */

test('below 640 the class list is cards, not a table with cut-off columns', () => {
  assert.match(seminars, /table-fixed max-\[640px\]:block max-\[640px\]:min-w-0/, 'the table is unblocked')
  assert.match(seminars, /<tbody class="max-\[640px\]:block">/, 'so is the body')
  assert.match(seminars, /<thead class=\{cn\('max-\[640px\]:hidden'/, 'the column header goes away')
  const line = row()
  assert.match(line, /max-\[640px\]:flex max-\[640px\]:flex-wrap/, 'the row is laid out with flex')
})

test('the card is assembled by cell order: title and menu on top, the rest below them', () => {
  const line = row()
  // Six cells and six numbers: the menu rises to the title instead of staying
  // sixth somewhere under the date.
  const orders = [...line.matchAll(/max-\[640px\]:order-(\d)/g)].map((m) => Number(m[1]))
  assert.deepEqual([...orders].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6], 'every cell knows its place')
})

test('the first line of a card is measured for the menu button, and both numbers are one', () => {
  const line = row()
  // Underscores are spaces: `calc(100%-44px)` without them is not computed at
  // all, the rule silently drops out, and the menu button slides to the
  // second line of the card. Checked on the test bench: that is exactly how
  // this fix broke the first time.
  const name = line.match(/max-\[640px\]:basis-\[calc\(100%_-_(\d+)px\)\]/)
  const menu = line.match(/max-\[640px\]:basis-(\d+)\b/)
  assert.ok(name, 'the title takes everything except the space for the menu')
  assert.ok(menu, 'and the menu is that space')
  // Once these two numbers diverge, they push the menu button to the second
  // line, under the environment and the date, where nobody looks for it.
  assert.equal(Number(name[1]), Number(menu[1]) * 4, 'the subtracted pixels and the menu width match')
})

test('the card is pressed with a finger: the menu and the room address are 44px', () => {
  const line = row()
  assert.match(line, /max-\[640px\]:h-11 max-\[640px\]:w-11/, 'the actions button is 44×44')
  // 24px is enough for a mouse. A negative margin next to it gives the card
  // its height back, so the target grows while the line does not.
  assert.match(line, /max-\[640px\]:min-h-\[44px\]/, 'the room address is a target, not a caption')
})

test('the card shows how many people are in the room right now', () => {
  const line = row()
  // On a desktop this number stands in its own column; on a phone there are
  // no columns, and "live" without a number does not tell a room with one
  // visitor from a full cohort.
  const chip = line.slice(line.indexOf("seminar.status === 'live'"))
  assert.match(chip, /·\s*\{seminar\.liveCount\}/, 'the chip carries the number')
  assert.match(chip, /max-\[640px\]:inline/, 'and only on a phone: on a desktop it is in its own column')
})

test('no row action is lost on a phone: there is one markup', () => {
  // A second markup for the phone would mean a second list of actions. There
  // is none here by construction: there is exactly one menu in the file, and
  // the card opens the same one.
  const menus = [...seminars.matchAll(/role="menu"/g)]
  assert.equal(menus.length, 1, 'there is one row menu for both views')
  const copies = [...seminars.matchAll(/data-copy=\{seminar\.id\}/g)]
  assert.equal(copies.length, 1, 'and one room address in the row')
  // And it is still complete: open, rename, settings, the bell, publication,
  // archive, delete.
  const items = [...seminars.matchAll(/role="menuitem"/g)]
  assert.ok(items.length >= 9, `${items.length} menu items, expected at least nine`)
})

/* -------------------------------------------------------------- header */

test('the screen header on a phone is a full-width column', () => {
  const start = seminars.indexOf('{#snippet actions()}')
  const head = seminars.slice(start, seminars.indexOf('{/snippet}', start))
  const wide = [...head.matchAll(/max-\[640px\]:w-full/g)]
  assert.ok(wide.length >= 2, 'both the search and "New class" take the full width')
  const tall = [...head.matchAll(/max-\[640px\]:h-11/g)]
  assert.ok(tall.length >= 2, 'and both are finger-sized, not cursor-sized')
  // A percentage is computed from the parent, and the parent shrank to its
  // content: without a width on it, `w-full` inside is a percentage of an
  // unknown number.
  assert.match(page, /flex-wrap items-center gap-2 max-\[640px\]:w-full/, 'the actions row knows its width')
})

/* ----------------------------------------------------- environments */

/** An environment row, from its `{#each}` to the end of the card header. */
function envRow(): string {
  const start = environments.indexOf('{#each envs.environments as env')
  assert.notEqual(start, -1, 'the environment list is in place')
  const end = environments.indexOf('{#if env.packages.length > 0', start)
  assert.notEqual(end, -1, 'the card header has an end')
  return environments.slice(start, end)
}

test('below 640 an environment row wraps instead of squeezing the name to zero', () => {
  const row = envRow()
  assert.match(row, /max-\[640px\]:flex-wrap/, 'the row can wrap')
  assert.match(row, /max-\[640px\]:items-start/, 'and the parts align to the top')
  // The name was `flex-1` among `shrink-0`: only it shrank, and at 390px it
  // was not visible at all.
  assert.match(row, /max-\[640px\]:line-clamp-2/, 'the name reads as two lines')
  assert.match(row, /min-\[641px\]:truncate/, 'and as one line on a desktop, as before')
  assert.match(row, /max-\[640px\]:whitespace-normal/, 'the facts line wraps instead of being cut off')
})

test('the GPU badge does not overlap the state: the name line is allowed to wrap', () => {
  const row = envRow()
  // A `shrink-0` badge inside a line squeezed to zero was printed on top of its neighbour.
  const nameLine = row.slice(row.indexOf('{env.name}') - 400, row.indexOf('GPU') + 10)
  assert.match(nameLine, /max-\[640px\]:flex-wrap/, 'the badge moves to its own line instead of on top of another')
  assert.match(nameLine, /max-\[640px\]:min-w-0/, 'and the name next to it can become narrower')
})

test('the first line of an environment card is measured for the menu button', () => {
  const row = envRow()
  const name = row.match(/max-\[640px\]:basis-\[calc\(100%_-_(\d+)px\)\]/)
  assert.ok(name, 'the name takes everything except the space for the swatch, the gaps and the menu')
  const swatch = row.match(/class="h-2\.5 w-(2\.5) shrink-0/)
  const gap = row.match(/max-\[640px\]:gap-x-(\d+)/)
  const menu = row.match(/max-\[640px\]:h-11 max-\[640px\]:w-(11)\b/)
  assert.ok(swatch && gap && menu, 'the swatch, the gap and the menu are named by numbers')
  // Swatch + gap + gap + menu. Once these numbers diverge, they push the menu
  // button under the name, the very place where nobody looks for it.
  const vacated = step(swatch[1]) + step(gap[1]) * 2 + step(menu[1])
  assert.equal(Number(name[1]), vacated, `${name[1]}px subtracted, ${vacated}px taken`)
})

test('the environment states and action move under the name, not past the screen edge', () => {
  // One number on a shared constant rather than on each pill in place: there
  // are six pills over five branches, and they can drift apart only all at
  // once.
  assert.match(environments, /const PILL =[^;]*max-\[640px\]:order-1/, 'the pills go to the second line')
  const action = environments.match(/const ROW_ACTION =[\s\S]*?'\s*(?=\/\*|const|let|\n\s*\/\*\*)/)
  assert.ok(action, 'the row action has one constant for both branches')
  for (const rule of [
    'max-\\[640px\\]:order-1',
    'max-\\[640px\\]:w-full',
    'max-\\[640px\\]:h-auto',
    'max-\\[640px\\]:min-h-\\[44px\\]',
  ]) {
    assert.match(action[0], new RegExp(rule), `${rule} on the action button`)
  }
  // "Use as default" is 293px on one line, and a fixed 32px height held it.
  // Two rules, and both must stand together.
  assert.match(environments, /const ROW_ACTION =[\s\S]*?max-\[640px\]:py-2/, 'two-line text has room to breathe')
  // And exactly once: a long class string copied into the second branch is
  // two buttons that diverge at the very first edit.
  assert.equal([...environments.matchAll(/class=\{ROW_ACTION\}/g)].length, 2, 'both branches take it')
})

/* ---------------------------------------------------------- teachers */

test('below 640 the teacher registry is cards, not lanes past the edge', () => {
  assert.match(teachers, /min-w-\[600px\] max-\[640px\]:min-w-0/, 'the 600px minimum is removed')
  assert.match(
    teachers,
    /sticky top-0 z-10 flex h-9 items-center border-b border-line bg-canvas max-\[640px\]:hidden/,
    'the lanes header goes away together with the lanes',
  )
  assert.match(teachers, /min-h-\[66px\] items-center border-b border-line-soft max-\[640px\]:flex-wrap/, 'the row wraps')
  // One constant for three lanes: role, link and last sign-in behave the
  // same, and they can drift apart only together.
  assert.match(teachers, /const PHONE_LANE = '[^']*max-\[640px\]:order-1[^']*max-\[640px\]:w-full/, 'each lane gets its own line')
  for (const col of ['COL_ROLE', 'COL_LINK', 'COL_SEEN']) {
    assert.match(teachers, new RegExp(`const ${col} = \`[^\`]*\\$\\{PHONE_LANE\\}\``), `${col} takes it`)
  }
})

test('the first line of a teacher card is measured for the menu button', () => {
  const person = teachers.match(/const COL_PERSON =[\s\S]*?max-\[640px\]:basis-\[calc\(100%_-_(\d+)px\)\]/)
  const menu = teachers.match(/const COL_MENU = 'w-10 shrink-0 max-\[640px\]:w-(\d+)'/)
  assert.ok(person && menu, 'the person and the menu are named by numbers')
  assert.equal(Number(person[1]), step(menu[1]), 'the subtracted pixels and the menu width match')
})

test('the lane captions move into the card with the same words as in the header', () => {
  // A masked row of dots and "never" without a caption do not say what is
  // "never" and what the dots are: the lanes header is hidden on a phone.
  const lanes = [...teachers.matchAll(/@render lane\(tr\("([^"]+)"\)\)/g)].map((m) => m[1])
  assert.equal(lanes.length, 3, 'role, link and last sign-in are captioned')
  const head = teachers.slice(teachers.indexOf('sticky top-0'), teachers.indexOf('{#if listError}'))
  const heading = [...head.matchAll(/@render eyebrow\(tr\("([^"]+)"\)\)/g)].map((m) => m[1])
  for (const key of lanes) {
    assert.ok(heading.includes(key), `${key} is the same word as the lane has in the header`)
  }
  // And only on a phone: on a desktop the caption stands in the header, and a
  // second copy of it in every row is noise over the whole table.
  assert.match(teachers, /\{#snippet lane\(text: string\)\}\s*<span class="mb-1 hidden max-\[640px\]:block">/, 'the caption is visible only below 640')
})

test('the teacher card is pressed with a finger: both buttons are 44×44', () => {
  const targets = [...teachers.matchAll(/max-\[640px\]:h-11 max-\[640px\]:w-11/g)]
  assert.equal(targets.length, 2, 'copying the link and the row menu')
})

test('the "Setup token" section folds into a column, not into a one-word-wide column', () => {
  const start = teachers.indexOf('admin.setup.token')
  const section = teachers.slice(start - 400, start + 200)
  // `flex-1` is `flex-basis: 0`: the text asked for ZERO width, no wrapping
  // happened, and at 390px it got eight pixels next to an unshrinkable
  // button, while the uppercase caption was printed on top of it.
  assert.match(section, /flex-1 max-\[640px\]:basis-full/, 'the text asks for the full width')
  assert.match(teachers, /btn-outline shrink-0 max-\[640px\]:h-11 max-\[640px\]:w-full/, 'the button stands under it, at full width')
})

/* ----------------------------------------------------- rules toggle */

test('below 640 the rule segments stack into a column and are not cut off by the edge', () => {
  // Three segments with `white-space: nowrap` are 311px, while a line on a
  // 390px screen has 278 left: the group is `shrink-0`, and the right
  // segment got cut off.
  assert.match(rules, /flex shrink-0 border border-line max-\[640px\]:w-full max-\[640px\]:flex-col/, 'the group becomes a column')
  const phone = rules.slice(rules.indexOf('@media (max-width: 640px)'))
  assert.ok(phone, 'the segments have a phone rule')
  assert.match(phone, /border-right: 0/, 'the right border is removed')
  assert.match(phone, /border-bottom: 1px solid rgb\(var\(--line\)\)/, 'and replaced with a bottom one')
  assert.match(phone, /\.rule-seg:last-child \{ border-bottom: 0/, 'except the last one, otherwise there is a double line at the bottom')
  assert.match(phone, /height: 44px/, 'and the height is for a finger, not a cursor')
})

test('the toggle has one breakpoint: the layout class and the border media rule', () => {
  // A column with right borders draws a line along the right edge, a row
  // with bottom borders a strip under every button. Once the two breakpoints
  // diverge, there is a width where both are visible.
  const layout = rules.match(/max-\[(\d+)px\]:flex-col/)
  const borders = rules.match(/@media \(max-width: (\d+)px\)/)
  assert.ok(layout && borders, 'both breakpoints are named by a number')
  assert.equal(layout[1], borders[1], 'and it is one number')
})

/* ---------------------------------------------------- new class */

test('the "where the notebook comes from" doors are full width on a phone, not their own 182px', () => {
  // The 182px ceiling is the measure of a row of three doors, and there is no
  // row on a phone: the doors stacked into a column, but each with a dead
  // margin on the right.
  assert.match(newSeminar, /const DOOR =[\s\S]*?max-\[640px\]:max-w-none/, 'the ceiling is removed')
  assert.match(newSeminar, /const DOOR =[\s\S]*?max-\[640px\]:basis-full/, 'and the door asks for the full width')
})
