/**
 * `make host` changes the room address without bringing the room down.
 *
 * The service re-reads PUBLIC_URL from .env at least once every two seconds
 * (server/src/config.ts · readPublicUrl), so the new address arrives on its
 * own. A restart for its sake broke the sockets of the whole audience — most
 * noticeably when `make host` is repeated in the middle of a class because the
 * tunnel went down: the hall went into reconnecting for no reason. And without
 * a restart something has to wait until the address has arrived — and
 * `/api/health` names the address the server is currently writing into links,
 * so one can wait for an answer rather than for time to pass.
 *
 * Both properties are easy to lose with a revert "just in case": first
 * `systemctl restart` comes back, then "let's just sleep a bit longer". Here
 * they are pinned down.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = fs.readFileSync(path.join(repo, 'scripts/host.sh'), 'utf8')

test('cluster relay uses loopback ingress and the controlled public URL operation', () => {
  assert.match(script, /COLLOQ_CLUSTER/)
  assert.match(script, /PORT=30080/)
  assert.match(script, /scripts\/cluster\.sh public-url "\$PUBLIC"/)
})

/** Script lines without comments: the comments are exactly where this bug is described. */
const code = script
  .split('\n')
  .map((line) => (/^\s*#/.test(line) ? '' : line))
  .join('\n')

test('the address arrives without restarting the service', () => {
  const restarts = code
    .split('\n')
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => /systemctl\s+(restart|reload-or-restart)\s+colloq/.test(line))
  assert.deepEqual(
    restarts,
    [],
    `scripts/host.sh restarts the service for the sake of an .env it re-reads anyway: ${restarts
      .map(([n, line]) => `${n}: ${line.trim()}`)
      .join('; ')}`,
  )
})

test('the script asks the service for the address instead of waiting out a delay', () => {
  const branch = code.slice(code.indexOf('\n  service)'), code.indexOf('\n  container)'))
  assert.ok(branch.length > 0, 'the service branch in host.sh was not found — nothing to check')
  assert.match(
    branch,
    /api\/health/,
    'waiting for the new address does not ask /api/health — so it waits blindly',
  )
  assert.match(
    branch,
    /publicUrl/,
    'the health answer is not checked against the address just written (the publicUrl field)',
  )
})

test('health really does name the address — otherwise there is nothing to wait for', async () => {
  // The field on the server side: without it the check above would wait for a
  // match that never comes. It is checked in the route's code, not in a live
  // response: starting the app for one line costs more than it is worth.
  const app = fs.readFileSync(path.join(repo, 'server/src/app.ts'), 'utf8')
  assert.match(app, /publicUrl:\s*config\.publicUrl/)
})
