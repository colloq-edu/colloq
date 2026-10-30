/**
 * The contest pages' addresses (`/a/<slug>…`), read the way App reads them.
 *
 * A regex that stopped matching does not break the build: it sends a class
 * that typed `/a/algo/c` from the board to the panel's sign-in screen, and
 * that is found in class. Every shape the pages link to is pinned here, and
 * so is the way back from a route to its address — the tabs and the rail of
 * letters link to what `contestRoutePath` writes, so the two must agree.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contestRoutePath,
  readCompetitionRoute,
  readContestRoute,
  readCourseId,
  readPublicRoute,
  readRoomRoute,
  type ContestRoute,
} from '../web/src/lib/routes.js'
import { contestPath, letterPosition, MAX_PROBLEMS, problemLetter } from '../shared/contests.js'

const TABLE: [string, ContestRoute][] = [
  ['/a/algo-k2', { slug: 'algo-k2', view: 'problems', letter: null }],
  ['/a/algo-k2/', { slug: 'algo-k2', view: 'problems', letter: null }],
  ['/a/algo-k2/c', { slug: 'algo-k2', view: 'problems', letter: 'C' }],
  ['/a/algo-k2/c/', { slug: 'algo-k2', view: 'problems', letter: 'C' }],
  ['/a/algo-k2/a', { slug: 'algo-k2', view: 'problems', letter: 'A' }],
  ['/a/algo-k2/z', { slug: 'algo-k2', view: 'problems', letter: 'Z' }],
  ['/a/algo-k2/submissions', { slug: 'algo-k2', view: 'submissions', letter: null }],
  ['/a/algo-k2/leaderboard', { slug: 'algo-k2', view: 'leaderboard', letter: null }],
  ['/a/algo-k2/leaderboard/', { slug: 'algo-k2', view: 'leaderboard', letter: null }],
  ['/a/algo-k2/leaderboard/screen', { slug: 'algo-k2', view: 'screen', letter: null }],
  ['/a/algo-k2/leaderboard/screen/', { slug: 'algo-k2', view: 'screen', letter: null }],
  ['/a/algo-k2/questions', { slug: 'algo-k2', view: 'questions', letter: null }],
  // A one-letter contest is a contest, and its problems still read as problems.
  ['/a/b', { slug: 'b', view: 'problems', letter: null }],
  ['/a/b/c', { slug: 'b', view: 'problems', letter: 'C' }],
  // A contest may be called like a tab: the slug is always the first segment.
  ['/a/submissions', { slug: 'submissions', view: 'problems', letter: null }],
  ['/a/2026-graphs', { slug: '2026-graphs', view: 'problems', letter: null }],
]

test('every page of a contest reads as itself', () => {
  for (const [path, route] of TABLE) assert.deepEqual(readContestRoute(path), route, path)
})

test('what is not a contest page is not read as one', () => {
  for (const path of [
    '/a',
    '/a/',
    '/aa/algo',
    '/a/Algo',
    '/a/algo_k2',
    '/a/algo k2',
    '/a/algo/C',
    '/a/algo/cc',
    '/a/algo/1',
    '/a/algo/c/d',
    '/a/algo/screen',
    '/a/algo/submissions/screen',
    '/a/algo/questions/screen',
    '/a/algo/leaderboard/screen/x',
    '/a/algo/settings',
    `/a/${'x'.repeat(65)}`,
    '/k/algo',
    '/s/algo',
  ]) {
    assert.equal(readContestRoute(path), null, path)
  }
  // The longest address a slug may have still opens.
  assert.equal(readContestRoute(`/a/${'x'.repeat(64)}`)?.slug, 'x'.repeat(64))
})

test('a route written back is the address it was read from', () => {
  for (const [, route] of TABLE) {
    const path = contestRoutePath(route)
    assert.deepEqual(readContestRoute(path), route, path)
    assert.doesNotMatch(path, /\/$/, `${path}: the canonical address has no trailing slash`)
  }
  assert.equal(contestRoutePath({ slug: 'algo', view: 'problems', letter: 'C' }), '/a/algo/c')
  assert.equal(contestRoutePath({ slug: 'algo', view: 'screen', letter: null }), '/a/algo/leaderboard/screen')
  // The shared address of a contest (the server's links, the panel's «Открыть») is the first page here.
  assert.equal(contestRoutePath({ slug: 'algo', view: 'problems', letter: null }), contestPath('algo'))
})

test('the letter in the address is the letter the tables print, for all twenty-six', () => {
  for (let position = 0; position < MAX_PROBLEMS; position++) {
    const letter = problemLetter(position)
    const route = readContestRoute(`/a/algo/${letter.toLowerCase()}`)
    assert.equal(route?.letter, letter)
    assert.equal(letterPosition(route!.letter!), position)
  }
})

test('the contest door overlaps with none of the others', () => {
  for (const path of ['/a/algo', '/a/algo/c', '/a/algo/leaderboard/screen']) {
    assert.equal(readCompetitionRoute(path), null, path)
    assert.equal(readRoomRoute(path), null, path)
    assert.equal(readPublicRoute(path), null, path)
    assert.equal(readCourseId(path), null, path)
  }
  // And a competition's address stays a competition's.
  assert.equal(readCompetitionRoute('/k/algo')?.slug, 'algo')
  assert.equal(readContestRoute('/k/algo/leaderboard'), null)
})
