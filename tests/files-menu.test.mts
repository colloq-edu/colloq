/**
 * The row menu in the files panel — contents, permissions and manners.
 *
 * Everything here is read from the sources, as in `panels-craft.test.mts`,
 * and for the same reason: the contents of the menu and the rule by which
 * each item goes dark cannot be checked with a pure function or a socket —
 * it is markup. And it breaks silently: an item dimmed by the wrong rule
 * looks exactly like one dimmed by the right one, and the person goes
 * looking for a teacher who forbade nothing.
 *
 * The second thing pinned here is lessons bought on a live test stand. A
 * bottom-sheet backdrop without a handler of its own, a "⋯" button with a
 * forty-pixel target, returning focus to the row: each of these places has
 * already broken once, and each rolls back with a single line.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roomMessages } from '../shared/locales/room.js'
import { serverMessages } from '../shared/locales/server.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup and code without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const FILES = 'web/src/components/panels/FilesPanel.svelte'
const MENU = 'web/src/components/ui/ContextMenu.svelte'

/** A function's body from its declaration to the next declaration of the same level. */
function body(source: string, from: string, to: string): string {
  const at = source.indexOf(from)
  assert.ok(at > 0, `could not find ${from}`)
  const end = source.indexOf(to, at)
  assert.ok(end > at, `could not find ${to} after ${from}`)
  return source.slice(at, end)
}

/* ------------------------------------------------------- menu contents */

test('the file menu goes in one order: open, copy, take, change', () => {
  /*
   * The order is not decoration. First what a click does (open), then the
   * harmless (copying and downloading), and only as the last group — the
   * irreversible. "Delete…" stands at the bottom and alone, behind a
   * separator: a mouse slip onto the row above must not land on it.
   */
  const files = code(read(FILES))
  const menu = body(files, 'function fileItems(', 'function folderItems(')
  const order = [...menu.matchAll(/tr\('(room\.files\.menu\.[a-zA-Z]+)'\)/g)].map((m) => m[1])
  assert.deepEqual(order, [
    'room.files.menu.open',
    'room.files.menu.run',
    'room.files.menu.copyPath',
    'room.files.menu.copyName',
    'room.files.menu.download',
    'room.files.menu.duplicate',
    'room.files.menu.rename',
    'room.files.menu.remove',
  ])
  /*
   * Separators — three for four groups. The first is conditional: a binary
   * file has no "Open" at all, and a separator at the very top of the menu
   * would be a separator with nothing above it.
   */
  assert.match(menu, /gap: items\.length > 0/)
  assert.equal([...menu.matchAll(/gap: true/g)].length, 2)
})

test('the path from the class folder is copied, and separately the name', () => {
  const menu = body(code(read(FILES)), 'function fileItems(', 'function folderItems(')
  assert.match(menu, /copyItem\(path, tr\('room\.files\.menu\.copyPath'\)\)/)
  assert.match(menu, /copyItem\(entry\.name, tr\('room\.files\.menu\.copyName'\)\)/)
  // And nothing third: the line for a cell ("pd.read_csv(…)") was removed
  // from the menu, and with it the whole `snippetFor`.
  const files = read(FILES)
  assert.ok(!files.includes('snippetFor'), 'snippetFor is back in the panel')
  assert.ok(!files.includes('read_csv'), 'the line for a cell is back in the panel')
})

test('nothing to open — no item either: a binary file has only "Download"', () => {
  // A click on a binary file DOWNLOADS it (see `pick`), and "Open" next to
  // "Download" would be two captions for one action.
  const menu = body(code(read(FILES)), 'function fileItems(', 'function folderItems(')
  assert.match(menu, /if \(kind !== 'binary'\)/)
})

test('the folder menu creates things inside it, and does not allow duplicating a folder', () => {
  const folder = body(code(read(FILES)), 'function folderItems(', 'function panelItems(')
  for (const item of ['newFileHere', 'newDirHere', 'newBookHere', 'uploadHere', 'copyPath']) {
    assert.match(folder, new RegExp(`room\\.files\\.menu\\.${item}`), `item ${item} is missing`)
  }
  assert.match(folder, /startDraftIn\('file', path\)/)
  assert.match(folder, /uploadInto\(path\)/)
  // The item is there but dimmed, and the reason is the same phrase the
  // server would refuse with.
  assert.match(folder, /disabled: true,[\s\S]{0,240}tr\('server\.files\.copyFolder'\)/)
})

test('the empty space of the panel offers only what goes into the class folder', () => {
  const panel = body(code(read(FILES)), 'function panelItems(', 'const menuItems')
  const order = [...panel.matchAll(/tr\('(room\.files\.menu\.[a-zA-Z]+)'\)/g)].map((m) => m[1])
  assert.deepEqual(order, [
    'room.files.menu.newFile',
    'room.files.menu.newDir',
    'room.files.menu.newBook',
    'room.files.menu.upload',
  ])
  // Neither rename nor delete: the root of the class folder has no row of
  // its own.
  assert.ok(!panel.includes('rename'), 'rename got into the root menu')
  assert.ok(!panel.includes('remove'), 'delete got into the root menu')
})

/* --------------------------------------------------------- permissions */

test('duplicating asks `files`, while rename and delete ask the role', () => {
  /*
   * A copy ADDS a file, like "new file" and like an upload — so its rule is
   * the same, `files`. Rename and delete REMOVE the old path, and they are
   * the teacher's; the one exception is one's own personal notebook. The
   * server decides exactly the same (control.ts · tree:copy, tree:move,
   * tree:remove).
   */
  const files = code(read(FILES))
  assert.match(files, /const mayRename = \$derived\(isHost && may\.files\)/)
  assert.match(files, /const mayRemove = \(path: string\): boolean => isHost \|\| myBook\(path\)/)
  const menu = body(files, 'function fileItems(', 'function folderItems(')
  assert.match(menu, /room\.files\.menu\.duplicate'\),[\s\S]{0,260}disabled: !may\.files/)
  assert.match(menu, /room\.files\.menu\.rename'\),[\s\S]{0,160}disabled: !mayRename/)
  assert.match(menu, /room\.files\.menu\.remove'\),[\s\S]{0,200}disabled: !mayRemove\(path\)/)
})

test('after the bell the phrase about the rule gives way to the phrase about the class', () => {
  // `may.filesWhy` after the bell is already CLASS_IS_OVER (lib/may.ts), and
  // "the teacher renames" in the middle of a finished class sends the person
  // the wrong way.
  const files = code(read(FILES))
  assert.match(
    files,
    /const whyEdit = \$derived\(may\.files \? tr\('room\.files\.menu\.hostOnly'\) : may\.filesWhy\)/,
  )
})

test('duplicating goes out as a tree:copy frame and nothing else', () => {
  const dup = body(code(read(FILES)), 'function duplicate(', '$effect(() => {')
  assert.match(dup, /session\.send\(\{ t: 'tree:copy', path: entry\.path \}\)/)
  assert.match(dup, /if \(!may\.files\)/, 'the permission is not checked before sending')
  // The copy's name is not made up here: the server chooses it.
  assert.ok(!dup.includes('копия'), 'the tab makes up the copy\'s name itself')
})

/* ------------------------------------------------------- component manners */

test('the menu is a menu: roles, a label and focus return', () => {
  const menu = code(read(MENU))
  assert.match(menu, /role="menu"/)
  assert.match(menu, /role="menuitem"/)
  assert.match(menu, /aria-label=\{label\}/)
  // Escape closes it and marks the key as eaten: the room closes the
  // terminal drawer with the same Escape.
  assert.match(menu, /event\.key === 'Escape'[\s\S]{0,260}event\.stopPropagation\(\)/)
  // Focus returns to where the menu was called from.
  assert.match(menu, /if \(back\?\.isConnected\) back\.focus\(\)/)
})

test('the menu lives above the room\'s drawers and below the refusal windows', () => {
  // z-40 — drawers, z-50 — the rules console, z-[96] — the ban menu, z-[97]
  // — the refusal window, z-[100] — "you were removed". The access menu on
  // the tab stands at z-[60], and this menu is there too.
  assert.match(code(read(MENU)), /z-\[60\]/)
})

test('the menu slides in and does not slide out: leaving must not be animated', () => {
  const menu = read(MENU)
  assert.doesNotMatch(code(menu), /transition:(fly|fade)/, 'a two-way directive')
  assert.match(menu, /in:fly=/)
  assert.match(menu, /import \{ quintOut \} from 'svelte\/easing'/)
  assert.match(menu, /prefersReducedMotion\(\)/)
})

test('on a finger the menu comes as a bottom sheet with 44-pixel targets', () => {
  /*
   * A popover under a finger gets closed by the finger itself and demands
   * 28-pixel targets. The signal is the same one `hoverOnlyWhenSupported`
   * uses to switch off `hover:` utilities — about the input device, not the
   * window width.
   */
  const menu = code(read(MENU))
  assert.match(menu, /matchMedia\('\(hover: none\) and \(pointer: coarse\)'\)/)
  assert.match(menu, /sheet \? 'h-11 gap-3 px-4 text-ui-lg' : 'h-7 gap-2 px-2\.5 text-ui'/)
  assert.match(menu, /inset-x-0 bottom-0/)
  assert.match(menu, /env\(safe-area-inset-bottom\)/)
})

test('the bottom sheet backdrop listens to nothing itself', () => {
  /*
   * The sheet opens on a LONG press: the finger is already on the screen,
   * and the browser hands its lift-off as a `click` on whatever is under the
   * finger — that is, on the backdrop. A button on it closed the sheet at
   * the very instant it was opened (checked on the test stand). A tap
   * outside is caught by the shared `pointerdown`.
   */
  const menu = code(read(MENU))
  const backdrop = body(menu, 'absolute inset-0 bg-canvas/70', '</div>')
  assert.ok(!backdrop.includes('onclick'), 'the backdrop closes the sheet on click again')
  assert.match(menu, /window\.addEventListener\('pointerdown', away, true\)/)
})

test('a dimmed item states the reason as a line, not only as a tooltip', () => {
  // `title` is visible under the pointer and never under a finger: on a
  // phone a dimmed item would stay mute.
  const menu = code(read(MENU))
  assert.match(menu, /data-menu-why/)
  assert.match(menu, /if \(!item\.disabled \|\| !item\.why \|\| out\.includes\(item\.why\)\) continue/)
  assert.match(menu, /title=\{item\.disabled \? \(item\.why \?\? undefined\) : undefined\}/)
})

/* ---------------------------------------------------------- dictionary */

test('every menu key exists in both languages and without Cyrillic in the English one', () => {
  const used = new Set(
    [...read(FILES).matchAll(/tr\('(room\.files\.menu\.[a-zA-Z]+)'/g)].map((m) => m[1]),
  )
  assert.ok(used.size >= 20, `suspiciously few menu keys: ${used.size}`)
  for (const key of used) {
    const pair = roomMessages[key]
    assert.ok(pair, `no key ${key}`)
    assert.ok(pair.ru && pair.en, `${key} does not have both languages`)
    assert.doesNotMatch(String(pair.en), /[А-Яа-яЁё]/, `Cyrillic in the English ${key}`)
  }
  // And the phrase about the folder comes from the server dictionary: the
  // server refuses with it.
  assert.ok(serverMessages['server.files.copyFolder'])
})

test('no strings of the old three-icon strip are left in the dictionary', () => {
  // "Copy a line for the cell", "Download {p0}", "Remove {p0}" and "Copy
  // {p0}" lived only for the sake of icons that are gone. A dead key gets
  // dragged into the build of every room screen.
  for (const gone of [
    'room.ui.594',
    'room.ui.596',
    'room.ui.597',
    'room.extra.272',
    'room.extra.273',
    'room.extra.274',
  ]) {
    assert.ok(!(gone in roomMessages), `key ${gone} remained in the dictionary`)
  }
})

test('the right-click hint is shown once and survives a private window', () => {
  const files = code(read(FILES))
  assert.match(files, /const TIP_KEY = 'colloq\.files\.menuTip'/)
  // Both reading and writing are in try/catch: in a private window, access
  // to storage throws, and the hint must not bring the panel down.
  assert.equal([...body(files, 'function tipWasSeen(', '{@render').matchAll(/catch \{/g)].length, 2)
  assert.match(files, /\{#if !tipSeen && listed\}/)
})

test('the presence circles do not go under "⋯": room for the button is reserved in advance', () => {
  const files = code(read(FILES))
  /*
   * 20 Sep 2026, from a class: "the three dots cover the circles, half of
   * the first one is visible". The button lies absolutely positioned at the
   * right edge and is painted over, so the strip of circles must end to the
   * left of it — and always, not on hover: the pointer is heading exactly
   * towards "⋯", and a shift under it would read as a breakage.
   */
  const lane = body(files, '{#if here.length > 0}', '{:else if !entry.dir}')
  assert.match(lane, /class="flex items-center gap-1 pr-\[26px\]"/)
  assert.doesNotMatch(lane, /group-hover:/, 'the circles must not move under the pointer')
  // And the button itself still stands absolutely positioned at the right
  // edge — otherwise the padding above reserves room for the wrong thing.
  assert.match(files, /class="absolute inset-y-0 right-0 flex items-center bg-raised/)
})
