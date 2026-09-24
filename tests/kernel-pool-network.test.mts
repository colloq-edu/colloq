/**
 * "Is this the right network" — a question with the seminar's variables
 * riding on the answer.
 *
 * The room container survives a server restart on purpose: `make run` after
 * an edit must not cost the class its state. The only thing standing in the
 * way is the network mode comparison: if it does not match, there is no road
 * to the container, so we tear it down and start an empty one. The comparison
 * was against the word `default`, and on docker 24+ (`bridge`) it NEVER
 * matched — that is, every first Run after a restart silently took away
 * everything the room had managed to compute.
 *
 * There is no real docker in the suite (see `_env.mts`), so the pure rule is
 * checked — the very line where the whole problem was.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { networkMatches } from '../server/src/kernel/pool.js'

test('in host mode a container without --network counts as ours', () => {
  // Docker 20 with its `default` and docker 24+ with its `bridge` are the same
  // state of affairs: the container was started without `--network`, and the
  // port is published on loopback.
  assert.equal(networkMatches('default', ''), true)
  assert.equal(networkMatches('bridge', ''), true)
  assert.equal(networkMatches('  bridge  ', ''), true)
})

test('in host mode a container from the compose network does not count as ours', () => {
  // There is no road to it: the port is not published, and the host does not
  // reach containers by name. Recreating such a container is right.
  assert.equal(networkMatches('colloq', ''), false)
  assert.equal(networkMatches('host', ''), false)
})

test('in network mode only the named network matches', () => {
  assert.equal(networkMatches('colloq', 'colloq'), true)
  assert.equal(networkMatches('bridge', 'colloq'), false)
  assert.equal(networkMatches('default', 'colloq'), false)
})
