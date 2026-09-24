/**
 * A file dragged into a folder, and everything this gesture ends with.
 *
 * What is checked is not path arithmetic but what the room will see on the
 * screen: where the entry will end up, when there is nothing to move, and
 * what stays unsaid then. The rules here stand in front of the server on
 * purpose: things never get to the server at all — the browser does not hand
 * out a target marked "not allowed", there will be no `drop` event, and people
 * always read the phrase from HERE. So it must match the server's words
 * verbatim, not just in meaning.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deepestAfter,
  dropFolder,
  landingPath,
  longestAfter,
  movedPaths,
  planMove,
  readsInside,
  type Row,
} from '../web/src/lib/tree-move.js'
import { parentOf } from '../shared/paths.js'
import type { FileEntry } from '../shared/protocol.js'

function file(path: string): FileEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, dir: false, size: 12, modifiedAt: 0 }
}
function dir(path: string): FileEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, dir: true, size: 0, modifiedAt: 0 }
}
/** A tree row the way the panel picks it up. */
function row(entry: FileEntry): Row {
  return { path: entry.path, dir: entry.dir }
}

/** The seminar folder in the same order as it is drawn. */
const TREE: FileEntry[] = [
  dir('data'),
  file('data/train.csv'),
  dir('src'),
  dir('src/deep'),
  file('src/model.py'),
  file('README.md'),
  file('train.csv'),
]

test('a file moves into a folder — and only then is a message sent', () => {
  const plan = planMove(row(file('README.md')), row(dir('src')), TREE)
  assert.deepEqual(plan, { do: 'move', from: 'README.md', to: 'src/README.md' })
})

test('a folder dropped onto itself goes nowhere — and nothing is reported', () => {
  /*
   * A slip of the finger, not a mistake. A refusal here would read as "the
   * folder cannot be touched at all", and the person would stop trying.
   */
  assert.deepEqual(planMove(row(dir('src')), row(dir('src')), TREE), { do: 'nothing' })
  // And dropping a folder onto a file lying right inside it is the same
  // gesture.
  assert.deepEqual(planMove(row(dir('src')), row(file('src/model.py')), TREE), { do: 'nothing' })
})

test('a folder cannot be put into its own subfolder, and this is said about the place, not the name', () => {
  /*
   * Having reached the server, this gesture comes back with the phrase
   * ""deep" is not valid as a name": the server refuses correctly but explains
   * it with the target's name. The name is fine — the place is not, and that
   * must be said here.
   */
  const plan = planMove(row(dir('src')), row(dir('src/deep')), TREE)
  assert.equal(plan.do, 'refuse')
  assert.equal(
    plan.do === 'refuse' ? plan.why : '',
    '«src» нельзя переместить внутрь себя.',
    'the refusal explains the wrong thing: the name instead of the place',
  )
})

test('a file dropped into its own folder does not raise tree:move', () => {
  // Otherwise every gesture that did not happen means a network round trip
  // and a blink of the whole list.
  assert.deepEqual(planMove(row(file('src/model.py')), row(dir('src')), TREE), { do: 'nothing' })
  assert.deepEqual(planMove(row(file('src/model.py')), row(file('src/model.py')), TREE), {
    do: 'nothing',
  })
  // And an entry already lying in the root, dropped outside the rows.
  assert.deepEqual(planMove(row(file('README.md')), null, TREE), { do: 'nothing' })
})

test('what is dropped onto a file lands in its folder, not on top of it', () => {
  /*
   * The same rule by which a file dragged in from the disk is placed. If they
   * diverged, the same gesture would put the file in different places.
   */
  assert.equal(dropFolder(row(file('src/model.py'))), 'src')
  assert.equal(dropFolder(row(dir('src'))), 'src')
  assert.equal(landingPath(row(file('README.md')), row(file('src/model.py'))), 'src/README.md')
  assert.deepEqual(planMove(row(file('README.md')), row(file('src/model.py')), TREE), {
    do: 'move',
    from: 'README.md',
    to: 'src/README.md',
  })
})

test('what is dropped outside the rows lands in the root', () => {
  // Empty space in the panel is the root of the seminar folder, not
  // "nowhere".
  assert.equal(dropFolder(null), '')
  assert.deepEqual(planMove(row(file('src/model.py')), null, TREE), {
    do: 'move',
    from: 'src/model.py',
    to: 'model.py',
  })
})

test('a taken name is named together with the folder where it is taken', () => {
  /*
   * `train.csv` lies both in the root and in `data`. "In this folder" pointed
   * to the one it is dragged FROM — that is, to the root, where there is no
   * collision — and the person went looking for a nonexistent second copy.
   * The server already tells these apart (`treeTrouble`), but nobody sees its
   * phrase: a target with "not allowed" does not hand out a `drop` event, and
   * people always read this one.
   */
  const plan = planMove(row(file('train.csv')), row(dir('data')), TREE)
  assert.equal(plan.do, 'refuse')
  assert.equal(plan.do === 'refuse' ? plan.why : '', '«train.csv» в папке «data» уже есть.')
  // A folder can take a name too — the server will refuse in that case as
  // well.
  const twins: FileEntry[] = [dir('a'), dir('a/deep'), dir('b'), dir('b/deep')]
  const folders = planMove(row(dir('a/deep')), row(dir('b')), twins)
  assert.equal(folders.do === 'refuse' ? folders.why : '', '«deep» в папке «b» уже есть.')
  // The root has no name, and "in the folder <empty>" would be a hole in the
  // phrase.
  const home = planMove(row(file('data/train.csv')), null, TREE)
  assert.equal(home.do === 'refuse' ? home.why : '', '«train.csv» в корне комнаты уже есть.')
})

test('a folder whose contents would go deeper than the cap in the new place does not move', () => {
  /*
   * Eight segments is the addressing cap. The server looks only at the
   * folder's own path and carries out such a move; after it, the tree walk
   * simply does not reach the contents, does not set the "not shown in full"
   * flag, and the subtree silently vanishes from the panel — there will be
   * nothing to open, download or remove it with.
   */
  const deep: FileEntry[] = [
    dir('a'),
    dir('a/b'),
    dir('a/b/c'),
    dir('a/b/c/d'),
    dir('a/b/c/d/e'),
    dir('a/b/c/d/e/f'),
    dir('a/b/c/d/e/f/g'),
    file('a/b/c/d/e/f/g/x.py'),
    dir('data'),
  ]
  assert.equal(deepestAfter(row(dir('a')), 'data', deep), 9, 'the depth is computed from the folder itself')
  const plan = planMove(row(dir('a')), row(dir('data')), deep)
  assert.equal(plan.do, 'refuse')
  assert.equal(
    plan.do === 'refuse' ? plan.why : '',
    'Допустимая глубина пути — до 8 уровней.',
  )
  // Exactly at the cap is allowed: the rule is about what does not fit, not
  // about headroom.
  assert.equal(planMove(row(dir('a/b')), row(dir('data')), deep).do, 'move')
})

test('what is no longer in the list is not dragged', () => {
  // The row was held while a new list arrived: the file was removed, the
  // folder renamed. Sending `tree:move` would mean getting a refusal one
  // round trip later, and not in the panel but in the shared error bar.
  const plan = planMove(row(file('old.csv')), row(dir('data')), TREE)
  assert.equal(plan.do, 'refuse')
  assert.equal(plan.do === 'refuse' ? plan.why : '', '«old.csv» в комнате больше нет.')
})

test('the highlight targets the same folder where the entry will land', () => {
  /*
   * The panel highlights `dropFolder` but sends `plan.to`. If they diverged,
   * they would give a row that lights up on one folder while the file goes
   * into another — and the person would look for it in the wrong place.
   * Checked on all pairs of the tree at once: the rule is one for a file, a
   * folder and empty space.
   */
  const spots: (FileEntry | null)[] = [...TREE, null]
  for (const dragged of TREE) {
    for (const onto of spots) {
      const here = onto ? row(onto) : null
      const plan = planMove(row(dragged), here, TREE)
      if (plan.do !== 'move') continue
      const where = onto?.path ?? '(root)'
      assert.equal(plan.to, landingPath(row(dragged), here), `${dragged.path} → ${where}`)
      assert.equal(
        parentOf(plan.to),
        dropFolder(here),
        `the highlight and the move diverged on ${dragged.path} → ${where}`,
      )
    }
  }
})

test('a folder takes along the tabs of everything in it', () => {
  /*
   * A tab knows the EXACT path: telling it just the folder name means moving
   * none of the ones the folder is dragged for. Then the file list arrives,
   * the tab on `src/model.py` is not found in it and closes together with the
   * document — that is, with what was typed and the undo history, and if it
   * was active, the centre of the room goes empty.
   */
  assert.deepEqual(movedPaths('src', 'data/src', TREE), [
    { from: 'src', to: 'data/src' },
    { from: 'src/deep', to: 'data/src/deep' },
    { from: 'src/model.py', to: 'data/src/model.py' },
  ])
  // A file speaks only for itself.
  assert.deepEqual(movedPaths('README.md', 'src/README.md', TREE), [
    { from: 'README.md', to: 'src/README.md' },
  ])
  // A neighbour with the same name prefix is not contents: `src2` starts with
  // `src` but does not lie inside `src`, and carrying its tab off would mean
  // losing it.
  const twins: FileEntry[] = [dir('src'), file('src/a.py'), dir('src2'), file('src2/b.py')]
  assert.deepEqual(movedPaths('src', 'x/src', twins), [
    { from: 'src', to: 'x/src' },
    { from: 'src/a.py', to: 'x/src/a.py' },
  ])
})

test('the server does not look inside a folder at the very bottom — and "empty" is not true about it', () => {
  /*
   * `listTree` reads directories while their contents fit in eight segments,
   * and does not set the "not shown in full" flag: it counts only rows.
   * Without this question, the panel drew "empty" under a folder with files in
   * it — and offered to remove it as empty.
   */
  assert.equal(readsInside(''), true, 'the root is always read')
  assert.equal(readsInside('a/b/c/d/e/f/g'), true, 'the server still walks the seventh level')
  assert.equal(readsInside('a/b/c/d/e/f/g/h'), false, 'the walk never reaches the bottom')
})

test('a folder whose contents would not fit in the path length in the new place does not move', () => {
  /*
   * The same hole as with depth, only in characters: the length is measured
   * on the path that was sent, and it is short. The contents go past four
   * hundred characters — and after that they can be neither opened, nor
   * downloaded, nor removed one by one (`normalizePath` does not let such a
   * path through), yet they take up space. "Remove" got a phrase about the
   * wrong thing: ""data.csv" is not valid as a name".
   */
  const long = 'a'.repeat(120)
  const far = 'b'.repeat(40)
  const tree: FileEntry[] = [
    dir(long),
    dir(`${long}/${long}`),
    dir(`${long}/${long}/${long}`),
    file(`${long}/${long}/${long}/data.csv`),
    dir(far),
    dir('x'),
  ]

  assert.equal(longestAfter(row(dir(long)), far, tree), 412, 'the length is computed from the folder itself')
  const plan = planMove(row(dir(long)), row(dir(far)), tree)
  assert.equal(plan.do, 'refuse')
  assert.equal(
    plan.do === 'refuse' ? plan.why : '',
    `«${long}» нельзя переместить: путь к содержимому превысит 400 символов.`,
  )
  // The same folder under a short name is allowed: the rule is about what
  // does not fit, not about headroom.
  assert.equal(planMove(row(dir(long)), row(dir('x')), tree).do, 'move')
})
