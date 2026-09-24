/**
 * Notebook = kernel — from the screen's side.
 *
 * The server runs each notebook in its own Python (server/src/kernel/index.ts),
 * and everything visible from that is easy to lose silently: a "READY" badge
 * over a notebook that is computing, the queue counter of a neighbouring
 * sheet, a "Restart" that takes away the variables of the wrong notebook. None
 * of these three fails in tests — each simply shows something untrue, and it
 * can be noticed only in a class where two notebooks are busy with different
 * things.
 *
 * It is read straight from the components — the same trick as in
 * panels-craft: a test with its own copy of the rule passes forever while the
 * file drifts away.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tr } from '../shared/i18n.js'
import { COUNCIL_SHARED_KERNEL_NOTE } from '../shared/notebook.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup and styles without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const NOTEBOOK = read('web/src/components/notebook/Notebook.svelte')
const CELL = read('web/src/components/notebook/CellView.svelte')
const SCREEN = read('web/src/screens/SessionScreen.svelte')
const TABS = read('web/src/components/reader/TabStrip.svelte')
const YREACTIVE = read('web/src/lib/yreactive.svelte.ts')

/* ------------------------------------------------------ notebook bar */

test('the notebook bar reads the kernel of ITS OWN notebook, not of the room', () => {
  const bar = code(NOTEBOOK)
  assert.match(
    bar,
    /const notebook = watchBookKernel\(session\.doc, \(\) => root\)/,
    'the bar went back to the room-wide state',
  )
  assert.doesNotMatch(bar, /watchNotebookMeta/, 'the room state is back in the notebook bar')
  // The badge and the counter are computed through it too — so that they do
  // not drift apart.
  assert.match(bar, /const kernel = \$derived\(notebook\.current\.kernelStatus\)/)
  assert.match(bar, /const queued = \$derived\(notebook\.current\.queue\.length\)/)
})

test('"Restart" and "Interrupt" from the bar name their own sheet', () => {
  const bar = code(NOTEBOOK)
  const restarts = [...bar.matchAll(/send\(\{ t: 'restart'[^}]*\}\)/g)].map((m) => m[0])
  assert.ok(restarts.length >= 2, `restarts in the bar: ${restarts.length}`)
  for (const one of restarts) {
    assert.match(one, /book/, `a restart without a sheet name: ${one}`)
  }
  /*
   * The server takes an Interrupt without a sheet as "the room's notebook" and
   * clears its queue — a neighbouring one this button has no business with.
   */
  const stop = bar.slice(bar.indexOf('function interruptMessage'))
  const body = stop.slice(0, stop.indexOf('\n  }'))
  // Both exits from the function name the sheet — and its type knows it.
  assert.equal(body.match(/return \{ t: 'interrupt'[^}]*book/g)?.length, 2, body)
  assert.doesNotMatch(body, /\{ t: 'interrupt' \}/, 'the nameless "Interrupt" is back')
})

test('the queue at a cell is counted in its notebook', () => {
  const cell = code(CELL)
  assert.match(cell, /watchBookKernel\(session\.doc, \(\) => bookRoot\)/)
  assert.match(cell, /queuePosition = \$derived\(notebook\.current\.queue\.indexOf\(id\)\)/)
})

/* --------------------------------------------------------- header and tabs */

test('the header indicator speaks about the OPEN notebook', () => {
  const screen = code(SCREEN)
  assert.match(screen, /const openKernel = watchBookKernel\(session\.doc, \(\) => openRoot\)/)
  assert.match(screen, /const kernel = \$derived\(KERNEL\[openKernel\.current\.kernelStatus\]\)/)
  assert.doesNotMatch(
    screen,
    /KERNEL\[meta\.current\.kernelStatus\]/,
    'the header shows the room state instead of the open notebook again',
  )
  // The advice about a kernel that did not come up concerns the same
  // notebook, not a neighbouring one.
  assert.match(screen, /openKernel\.current\.kernelProblem/)
  /*
   * The root is computed AFTER the notebook list and the tabs: it reads them,
   * and moved above them it would get emptiness on the first frame.
   */
  assert.ok(
    screen.indexOf('const openRoot = $derived(') > screen.indexOf('const books = watchBooks('),
    'the open notebook is computed before their list is known',
  )
})

test('a tab has a busy dot, and it is not a label', () => {
  const tabs = code(TABS)
  assert.match(tabs, /const busyOf = \(key: string\): boolean => bookOf\(key\)\?\.busy === true/)
  const dot = tabs.slice(tabs.indexOf('{#if busyOf(key)}'))
  const block = dot.slice(0, dot.indexOf('{/if}'))
  assert.match(block, /rounded-full/, 'the dot is no longer a dot')
  assert.match(block, /room\.book\.busy/, 'the dot has no words for those who cannot see it')
  assert.match(block, /prefersReducedMotion\(\)/, 'the dot blinks even where motion is turned off')
  // The tab row gets the busy state from outside: it does not read the
  // document itself.
  assert.match(code(SCREEN), /busy: bookBusy\.busy\(book\.root\)/)
})

/* ------------------------------------------------- reactive layer */

test('kernel state in the browser is read per notebook and wakes only its own', () => {
  const lib = code(YREACTIVE)
  assert.match(lib, /export function watchBookKernel/)
  assert.match(lib, /export function watchBookBusy/)
  /*
   * One box per FIELD, holding a "root → value" map, and all four are created
   * by the constructor. Per-notebook boxes created on first demand cost a
   * whole complaint on 20 Sep 2026: the first demand comes from the header's
   * `$derived`, state created inside a reaction is owned by that reaction,
   * and later writes do not wake it — the kernel badge showed "STARTING"
   * forever for a kernel that had come up. The full argument is at
   * `bookView`.
   */
  assert.match(lib, /readonly bookStatus = box<Record<string, KernelStatus>>\(\{\}\)/)
  assert.match(lib, /#views = new Map<string, BookKernelView>\(\)/)
  assert.doesNotMatch(lib, /BookKernelBoxes/, 'per-notebook boxes are back')
  // Whoever can asks to read ahead of time — from the component body.
  assert.match(lib, /fields\.prime\(root\(\)\)/)
  // And the deferred read does not write to state while a derived value is
  // being computed.
  assert.match(lib, /queueMicrotask\(\(\) => this\.#readBooks\(root\)\)/)
  /*
   * The fallback answer for the room's notebook uses the old keys: a room with
   * an old snapshot and a tab that arrived before the first run must show the
   * truth, not "starting" forever.
   */
  assert.match(lib, /bookKernel\(this\.#doc, root\)/)
})

/* ------------------------------------ personal notebook resources in the rules */

test('personal notebook resources unfold under the rule, and only when it is on', () => {
  const rows = code(read('web/src/components/RoomRulesRows.svelte'))
  /*
   * A person asks themselves "may they" and "how much" in a row, in one
   * motion. A block on a separate screen would mean that most people never
   * answer the second question — and the "the same amount" default costs the
   * machine double.
   */
  assert.match(rows, /\{#if row\.key === 'ownBooks' && rules\.ownBooks === 'on'\}/)
  assert.match(rows, /ownMemoryMb: event\.currentTarget\.value === '' \? null : Number/)
  assert.match(rows, /ownCpus: event\.currentTarget\.value === '' \? null : Number/)
  // "Same as the class" is the empty choice, that is, `null`: it has no
  // separate switch, and adding one would be a second way of saying the same.
  assert.match(rows, /<option value="">\{asClassMemory\}<\/option>/)
  assert.match(rows, /room\.rules\.ownRes\.noGpu/)
  assert.match(rows, /room\.rules\.ownRes\.note/)
  // Phone: the choice grows to finger size, like the neighbouring segments.
  assert.match(rows, /@media \(max-width: 640px\)[\s\S]*?\.rule-pick \{\s*height: 44px/)
})

test('the rule words name things the way a teacher names them', () => {
  // The two lock modes are named THE SAME everywhere they are talked about.
  assert.equal(tr('room.ui.1130'), 'Пишут вместе')
  assert.equal(tr('room.ui.1131'), 'Каждый отвечает сам')
  assert.match(tr('room.ui.1079'), /пишут вместе/)
  // The personal notebooks rule names the kernel and the ceiling, in three
  // sentences.
  assert.match(tr('room.rules.ownBooks.note'), /своё ядро/)
  assert.match(tr('room.rules.ownBooks.note'), /трёх/)
  assert.equal(tr('room.rules.ownBooks.on'), 'Можно')
  // "One at a time" is about the notebook, not the room: there are as many
  // queues as notebooks (server/src/kernel/index.ts · requestRun).
  assert.match(tr('room.ui.1135'), /в тетради не больше одной ячейки/)
  // Clearing output is now per notebook too.
  assert.match(tr('room.ui.1162'), /ячеек тетради/)
  assert.match(tr('room.ui.1160'), /личной тетради/)
})

/* --------------------------------------------------------------- words */

test('the words about the kernel speak about the notebook, not the room', () => {
  // The council promise is one catalogue line, not a copy in the markup.
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /ядре этой тетради/)
  assert.match(tr(COUNCIL_SHARED_KERNEL_NOTE), /по очереди/)
  assert.doesNotMatch(tr(COUNCIL_SHARED_KERNEL_NOTE), /в общем ядре/)
  /*
   * The rule hint names the kernel; the GPU is covered by the resources block
   * under it — where people choose how much to hand out, and where "no GPU"
   * is the answer to the question "will they take the card?".
   */
  assert.match(tr('room.rules.ownBooks.note'), /своё ядро/)
  assert.match(tr('room.rules.ownRes.noGpu'), /GPU/)
})
