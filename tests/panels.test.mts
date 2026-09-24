/**
 * Two models of the centre of the screen: the reload fuse and the row of tabs.
 *
 * The fuse against an endless reload after an edit is refused.
 *
 * A refusal (4403) is cured by a reload together with clearing the cache. If
 * the clearing failed — a private window, storage forbidden — or if a
 * neighbouring tab brings the refused structure back over BroadcastChannel, the
 * loop closes: visit, refusal, reload, refusal again. The series is cut off at
 * the second attempt, and what is checked here is precisely the ORDER that used
 * to keep it from being cut off: the connection declares itself alive BEFORE
 * the refusal arrives — the server answers our SyncStep1 before it parses our
 * SyncStep2.
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { beginVisit, mayReload, refusalHealed } from '../web/src/lib/refusal.js'
import { restore, Tabs, type Room } from '../web/src/lib/tabs.svelte.js'

/*
 * Node has no sessionStorage — and the attempt count lives in it. A fake of
 * exactly the size the module reads.
 */
const store = new Map<string, string>()
;(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

test('a connection that came alive a moment before the refusal does not reset the series', () => {
  store.clear()
  mock.timers.enable({ apis: ['Date'], now: 0 })
  try {
    // Three rounds of the loop in a row: sync, a refusal half a second later, a reload.
    refusalHealed()
    mock.timers.tick(400)
    assert.equal(mayReload(), true)

    refusalHealed()
    mock.timers.tick(400)
    assert.equal(mayReload(), true)

    refusalHealed()
    mock.timers.tick(400)
    assert.equal(mayReload(), false, 'a third reload in a row is a loop')
  } finally {
    mock.timers.reset()
  }
})

test('a connection that lived for half a minute starts the count afresh', () => {
  store.clear()
  mock.timers.enable({ apis: ['Date'], now: 0 })
  try {
    refusalHealed()
    assert.equal(mayReload(), true)
    refusalHealed()
    assert.equal(mayReload(), true)
    refusalHealed()
    assert.equal(mayReload(), false)

    // The room worked for half a minute — so a refusal that happens now has
    // nothing to do with what came before the reload, and it is the first one again.
    refusalHealed()
    mock.timers.tick(30_000)
    assert.equal(mayReload(), true)
  } finally {
    mock.timers.reset()
  }
})

/* ------------------------------------------------------------------ tabs */

/*
 * The tab row is an ordinary class, but it lives in `.svelte.ts` and keeps its
 * state in runes. There is no compiler here, and `$state` remains a plain call:
 * the fake returns the value as is. It is installed before the first `new
 * Tabs`, not before the import, and that is enough: the rune is called on
 * construction, not on module load. Reactivity is not checked here — what is
 * checked is the row arithmetic that made a closed tab lead to the wrong place.
 */
;(globalThis as { $state?: unknown }).$state = <T,>(value: T): T => value

/*
 * Node has no tab storage either, and without it half of the model cannot be
 * checked: the row remembers both the tabs themselves and which of them is
 * open, and the empty room after F5 came from missing exactly this memory.
 */
const tabStore = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => tabStore.get(k) ?? null,
  setItem: (k: string, v: string) => void tabStore.set(k, v),
  removeItem: (k: string) => void tabStore.delete(k),
}

/** A separate set of tabs for each case: each has its own key, the name does not matter. */
function opened(...paths: string[]) {
  const tabs = new Tabs('t' + Math.random())
  for (const path of paths) tabs.open(path)
  return tabs
}

test('closing the third file of four lands on the second, not the first', () => {
  const tabs = opened('a.py', 'b.py', 'c.py')
  const board = 'Тетрадь.ipynb'
  assert.deepEqual(tabs.row(board), [board, 'a.py', 'b.py', 'c.py'])

  assert.equal(tabs.close('c.py', board), false)
  // The person is working with files: throwing them into the notebook is an extra trip back.
  assert.equal(tabs.active, 'b.py')
})

test('closing a tab other than the current one does not move away from the current one', () => {
  const tabs = opened('a.py', 'b.py')
  tabs.show('a.py')
  tabs.close('b.py', null)
  assert.equal(tabs.active, 'a.py')
})

test('the neighbour is computed on the same row that is drawn: the lecture is in it', () => {
  const tabs = opened('a.py', 'b.py')
  const lecture = 'лекция.pdf'
  tabs.show('a.py')
  // Without the lecture there is nothing to the left of a.py, and the move would go right, to b.py.
  tabs.close('a.py', null, lecture)
  assert.equal(tabs.active, lecture)
})

test('the shared document does not close for oneself: one can only leave it', () => {
  const tabs = opened('a.py')
  const board = 'разбор.py'
  tabs.show(board)
  assert.equal(tabs.close(board, board), true, 'the tab stays in the row')
  assert.equal(tabs.active, null)
  assert.deepEqual(tabs.row(board), [board, 'a.py'])
})

/* --------------------------------------------- returning to the room */

/*
 * Where a person lands after reloading the page in the middle of a class.
 *
 * The complaint from a live class was exactly about this: the notebook is open,
 * F5 — and an empty room, and the notebook has to be found again in the files
 * panel, by the whole group at once. The decision lives entirely in a pure
 * function, because it breaks silently and in three different ways: a memory
 * that is not there; a file that no longer exists; and a hall watching a lecture.
 */

const BOOK = 'Тетрадь.ipynb'

function room(alive: string[], board: string | null = null, firstBook: string | null = BOOK): Room {
  return { alive: new Set(alive), firstBook, board }
}

test('a reload returns the person to where they were', () => {
  assert.deepEqual(
    restore({ open: [BOOK, 'разбор.py'], active: 'разбор.py' }, room([BOOK, 'разбор.py'])),
    { open: [BOOK, 'разбор.py'], active: 'разбор.py' },
  )
})

test('the open file is gone: move to the neighbouring tab, not to an empty centre', () => {
  // The file was removed while the person was away: there is nothing to revive it
  // with as a tab, and no reason to.
  assert.deepEqual(restore({ open: [BOOK, 'разбор.py'], active: 'разбор.py' }, room([BOOK])), {
    open: [BOOK],
    active: BOOK,
  })
})

test('a hall watching a lecture outweighs the saved choice', () => {
  /*
   * A latecomer arrives where the room is looking. Their own notebook stays a tab
   * meanwhile: the screen is not taken from the room, but the memory is not thrown away either.
   */
  assert.deepEqual(
    restore({ open: [BOOK], active: BOOK }, room([BOOK, 'слайды.pdf'], 'слайды.pdf')),
    { open: [BOOK], active: 'слайды.pdf' },
  )
})

test('the first visit opens the room notebook without taking the screen from the room', () => {
  assert.deepEqual(restore(null, room([BOOK, 'разбор.py'])), { open: [BOOK], active: BOOK })
  assert.deepEqual(restore(null, room([BOOK, 'слайды.pdf'], 'слайды.pdf')), {
    open: [BOOK],
    active: 'слайды.pdf',
  })
})

test('closed everything: a visit does not reopen the notebook', () => {
  // An empty list in storage is the person's decision, not an absence of memory.
  assert.deepEqual(restore({ open: [], active: null }, room([BOOK])), { open: [], active: null })
})

test('the tabs and the open one among them survive a reload', () => {
  tabStore.clear()
  const first = new Tabs('kf3n8q2p')
  first.settle(room([BOOK]))
  first.open('разбор.py')
  first.show(BOOK)

  const again = new Tabs('kf3n8q2p')
  assert.deepEqual(again.mine, [BOOK, 'разбор.py'], 'the row is drawn before the server answers')
  assert.equal(again.active, BOOK, 'the centre of the screen is the notebook, not the watermark')
})

test('each room has its own memory', () => {
  tabStore.clear()
  new Tabs('room-a').open('разбор.py')
  assert.deepEqual(new Tabs('room-b').mine, [], 'the tabs of a neighbouring seminar do not come here')
  assert.deepEqual(new Tabs('room-a').mine, ['разбор.py'])
})

test('the first visit decides nothing until the room notebook has arrived', () => {
  /*
   * The file list comes over the control socket, the notebooks from the document,
   * and in a fresh room the files arrive first. Recording "the person closed
   * everything" in that gap would cancel a decision they never made — forever,
   * because "the first time" happens once.
   */
  tabStore.clear()
  const tabs = new Tabs('fresh')
  tabs.settle(room([], null, null))
  assert.deepEqual(tabs.mine, [])
  assert.equal(tabs.active, null)

  tabs.settle(room([BOOK]))
  assert.deepEqual(tabs.mine, [BOOK])
  assert.equal(tabs.active, BOOK)
})

test('a vanished file takes its tab with it on the next list too, even after the return', () => {
  tabStore.clear()
  const tabs = new Tabs('weed')
  tabs.settle(room([BOOK, 'разбор.py']))
  tabs.open('разбор.py')
  tabs.settle(room([BOOK]))
  assert.deepEqual(tabs.mine, [BOOK])
  assert.notEqual(tabs.active, 'разбор.py', 'a tab for a file that does not exist does not stay open')
})

test('an entry from the previous version is read, and garbage means "we remember nothing"', () => {
  tabStore.clear()
  // It used to remember just a list of paths; such entries already sit in browsers.
  tabStore.set('colloq.tabs.old', JSON.stringify([BOOK, 'разбор.py']))
  const old = new Tabs('old')
  assert.deepEqual(old.mine, [BOOK, 'разбор.py'])
  old.settle(room([BOOK, 'разбор.py']))
  assert.equal(old.active, BOOK, 'which one was open is unknown, so the leftmost opens')

  /*
   * A broken value is not "the person closed everything": the latter is left an
   * empty centre, while this one has to be returned to the notebook, not dropped
   * into that very empty room.
   */
  tabStore.set('colloq.tabs.junk', '{not json')
  const junk = new Tabs('junk')
  assert.deepEqual(junk.mine, [])
  junk.settle(room([BOOK]))
  assert.equal(junk.active, BOOK)
})

test('a manual reload starts the count afresh, a reload on refusal does not', () => {
  store.clear()
  mock.timers.enable({ apis: ['Date'], now: 0 })
  try {
    // The series is used up: two reloads on refusal in a row.
    assert.equal(mayReload(), true)
    assert.equal(mayReload(), true)
    assert.equal(mayReload(), false)

    // The page loaded because of a refusal: the mark is set, the count holds.
    store.set('colloq.refused.auto', '1')
    beginVisit()
    assert.equal(mayReload(), false, 'a reload on refusal reset the count')

    // The page loaded without the mark: the person pressed "reload" themselves.
    beginVisit()
    assert.equal(mayReload(), true, 'a manual reload did not start the count afresh')
  } finally {
    mock.timers.reset()
  }
})
