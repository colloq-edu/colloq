/**
 * Who publishes their place in the document — and what it costs the room.
 *
 * Presence is the chattiest wire in the product: the server relays every frame
 * to all connections without coalescing. While everybody published their
 * place, one step of the teacher at a lecture unfolded into N frames from N
 * listeners (their reader scrolls programmatically, after the leader) and N×N
 * deliveries: at five hundred, a quarter of a million messages per step and
 * millions per scrolled page.
 *
 * Exactly one function reads this place — `leaderFor`, and it takes only the
 * teacher. So the rule is one, but it has two sides: who is chosen as the
 * leader and who publishes a place at all. This checks that they have not
 * drifted apart — because they can drift silently and in either direction:
 * loosen `leaderFor`, and following a student will have nothing to follow.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mayBeFollowed } from '../shared/rules.js'
import { leaderFor } from '../web/src/lib/follow.js'
import type { Peer } from '../web/src/lib/session.svelte.js'

const FILE = 'lecture.pdf'

function peer(role: 'host' | 'participant', id: number): Peer {
  return {
    clientId: id,
    isSelf: false,
    user: {
      id: `p${id}`,
      name: 'Кто-то',
      avatar: null,
      color: '#000',
      role,
      viewing: { file: FILE, page: 3, y: 0.1 },
    },
  }
}

test('whoever is followed is the one who publishes: one rule, two sides', () => {
  for (const role of ['host', 'participant'] as const) {
    const followed = leaderFor([peer(role, 7)], FILE, null) !== null
    assert.equal(
      followed,
      mayBeFollowed(role),
      role === 'host'
        ? 'the teacher may be followed but does not publish a place: the room sees the board and has nobody to follow'
        : 'a student publishes a place nobody follows: a frame wasted on the whole room',
    )
  }
})

/* -------------------------------------------------- the publishing side */

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Markup and code without comments: an explanation is not a promise. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const READER = code(read('web/src/components/reader/PdfReader.svelte'))

test('the reader publishes a place only through the shared rule', () => {
  assert.match(
    READER,
    /mayBeFollowed\(session\.me\.role\)/,
    'the reader again decides on its own who publishes a place, with its own copy of the rule',
  )
  /*
   * Every publication of a place is behind the check, and the check is visible
   * on the same line. Clearing the place (`setViewing(null)`) is allowed without
   * it: that is not a frame for the room but cleanup after someone who may no longer publish.
   */
  const lines = READER.split('\n').filter((line) => /session\.setViewing\(\s*\{/.test(line))
  assert.ok(lines.length > 0, 'the reader stopped reporting a place at all: the teacher cannot be followed')
  for (const line of lines) {
    assert.match(
      line,
      /\bleads\b/,
      `unconditional setViewing in the reader: ${line.trim()} — a presence frame goes ` +
        'to the whole room on every scroll step of every listener',
    )
  }
})

test('scrolling does not publish the place of someone who may not be followed', () => {
  const at = READER.indexOf('function onScroll')
  assert.ok(at > 0, 'onScroll not found in the reader: the test is looking in the wrong place')
  const body = READER.slice(at, at + 500)
  assert.match(
    body,
    /if \(leads\) session\.setViewing/,
    'onScroll again sends a presence frame without checking whom the room may follow',
  )
})
