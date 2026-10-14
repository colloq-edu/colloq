/**
 * The machine's calls to its home (server/src/runner-agent/client.ts): what
 * is home's answer and what is a hiccup of the path, where the secret goes,
 * and how long the machine waits after a hiccup.
 *
 * A reply without the marker header is never home's (the relay's own page as
 * a 404 or a 502, frps's 504, frps's EOF turned into a 404): taken for home's
 * refusal, a relay restart would make the machine drop leases home still
 * counts on. And the secret goes in the Authorization header alone: a URL is
 * kept by every proxy and access log on the way, and the relay's page and a
 * wheel's CDN are not home.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { REMOTE_BACKOFF_MAX_MS, REMOTE_BACKOFF_MIN_MS, REMOTE_MARKER_HEADER, REMOTE_PROTOCOL, remoteCredential, type RemoteSyncRequest } from '../shared/remote-runner.ts'
import { Backoff, RemoteClient, retryAfter } from '../server/src/runner-agent/client.ts'
import { TEST_ROOT } from './_env.mts'
import { fakeHome, RUNNER_ID, SECRET, sha256, syncReply } from './_runner-agent-home.mts'

const credential = remoteCredential(RUNNER_ID, SECRET)

function syncBody(): RemoteSyncRequest {
  return {
    protocol: REMOTE_PROTOCOL, build: 'dev', seq: 0, holdMs: 1000, state: 'active',
    free: { slots: 1, memoryMb: 4096, cpus: 2, gpuShares: 0, diskMb: 10_000 }, cards: [],
    ready: { revisions: [], data: [], sealed: [], bundles: [] }, fetching: [], attempts: [], problems: [],
  }
}

test('a reply without the marker is a hiccup of the path, whatever its status; with the marker, 429 and 5xx are too', async () => {
  const home = await fakeHome()
  const client = new RemoteClient({ home: home.url, build: 'dev', credential: () => credential })
  try {
    const cases: Array<{ reply: Parameters<typeof home.onSync>[0] extends never ? never : any; kind: string; status?: number }> = [
      // The relay's own page for a room that is not open, as frps serves it.
      { reply: { status: 404, text: '<!doctype html><title>not open yet</title>', marker: false }, kind: 'transient' },
      { reply: { status: 502, text: '<html>Bad Gateway</html>', marker: false }, kind: 'transient' },
      { reply: { status: 504, text: 'Gateway Timeout', marker: false }, kind: 'transient' },
      // A 200 that is not home's is not an answer either.
      { reply: { status: 200, json: syncReply(), marker: false }, kind: 'transient' },
      { reply: { status: 429, json: { error: 'too_often' }, headers: { 'Retry-After': '7' } }, kind: 'transient' },
      { reply: { status: 503, json: { error: 'busy' } }, kind: 'transient' },
      { reply: { status: 500, json: { error: 'failed' } }, kind: 'transient' },
      // Home's own refusals, by their code.
      { reply: { status: 401, json: { error: 'unauthorized' } }, kind: 'refused:unauthorized' },
      { reply: { status: 409, json: { error: 'revoked' } }, kind: 'refused:revoked' },
      { reply: { status: 426, json: { error: 'protocol' } }, kind: 'refused:protocol' },
      // A refusal whose body does not say is named by its status.
      { reply: { status: 401, text: 'nope' }, kind: 'refused:unauthorized' },
      // A reply the contract's parser refuses: a proxy that mangled it, never a reason to drop anything.
      { reply: { status: 200, json: { ...syncReply(), surprise: 1 } }, kind: 'transient' },
      { reply: { status: 200, text: '{"seq":' }, kind: 'transient' },
      { reply: { status: 200, json: syncReply({ seq: 4 }) }, kind: 'ok' },
    ]
    for (const { reply, kind } of cases) {
      home.onSync = () => reply
      const answer = await client.sync(syncBody())
      const said = answer.kind === 'refused' ? `refused:${answer.error}` : answer.kind
      assert.equal(said, kind, JSON.stringify(reply).slice(0, 120))
      if (reply.headers?.['Retry-After']) assert.equal(answer.kind === 'transient' && answer.retryAfterMs, 7000)
    }
    // A connection that fails is a hiccup as well.
    const nowhere = new RemoteClient({ home: 'http://127.0.0.1:1', build: 'dev', credential: () => credential })
    assert.equal((await nowhere.sync(syncBody())).kind, 'transient')
  } finally {
    await home.close()
  }
})

test('the secret goes in the Authorization header and nowhere else; the join, the relay\'s page and the blobs\' path carry none of it', async () => {
  const home = await fakeHome()
  const client = new RemoteClient({ home: home.url, build: 'dev', credential: () => credential })
  const unsigned = new RemoteClient({ home: home.url, build: 'dev', credential: () => null })
  try {
    home.relay = { known: true, tunnel: false }
    await unsigned.join({ protocol: REMOTE_PROTOCOL, build: 'dev', code: 'f'.repeat(32), joinId: 'e'.repeat(32), facts: { version: '0.24.0', hostname: 'h', platform: 'linux/amd64', cpus: 4, memoryMb: 8000, diskMb: 100_000, docker: '28', storage: 'overlay2', driver: null } })
    await client.sync(syncBody())
    home.blobs.set(sha256('x'), Buffer.from('x'))
    const blob = await client.blob(sha256('x'), 0)
    if (blob.kind === 'ok') await blob.body.cancel()
    assert.equal(await client.relayState(), 'home_offline')
    for (const call of home.calls) {
      assert.ok(!call.path.includes(SECRET) && !String(call.headers.cookie ?? '').includes(SECRET), call.path)
      const authorization = String(call.headers.authorization ?? '')
      if (call.path.endsWith('/join') || call.path === '/.relay/state') assert.equal(authorization, '', `${call.path} is signed`)
      else assert.equal(authorization, `Bearer ${credential}`)
      for (const [name, value] of Object.entries(call.headers)) if (name !== 'authorization') assert.ok(!String(value).includes(SECRET), name)
    }
    // The code travels in the join's body, never in its path.
    const join = home.calls.find((call) => call.path.endsWith('/join'))!
    assert.equal((join.body as { code: string }).code, 'f'.repeat(32))
    assert.ok(!join.path.includes('f'.repeat(32)))
  } finally {
    await home.close()
  }
})

test('the relay tells home offline from home silent, and a missing relay from both', async () => {
  const home = await fakeHome()
  const client = new RemoteClient({ home: home.url, build: 'dev', credential: () => credential })
  try {
    home.relay = { known: true, tunnel: false }
    assert.equal(await client.relayState(), 'home_offline')
    home.relay = { known: true, tunnel: true }
    assert.equal(await client.relayState(), 'home_silent')
    home.relay = null
    assert.equal(await client.relayState(), 'unreachable')
    assert.equal(await new RemoteClient({ home: 'http://127.0.0.1:1', build: 'dev', credential: () => null }).relayState(), 'unreachable')
  } finally {
    await home.close()
  }
})

test('an upload is gzipped, with the file\'s own sha256 and length in its headers, and streams from the disk', async () => {
  const home = await fakeHome()
  const client = new RemoteClient({ home: home.url, build: 'dev', credential: () => credential })
  try {
    const answer = 'id,target\n' + Array.from({ length: 5000 }, (_, index) => `${index},0.5`).join('\n')
    const gz = path.join(TEST_ROOT, 'answer.csv.gz')
    fs.writeFileSync(gz, zlib.gzipSync(answer))
    const attempt = 'd'.repeat(32)
    const reply = await client.upload(attempt, 'submission.csv', gz, { sha256: sha256(answer), bytes: Buffer.byteLength(answer) })
    assert.equal(reply.kind, 'ok')
    assert.deepEqual(reply.kind === 'ok' && reply.value, { name: 'submission.csv', sha256: sha256(answer), bytes: Buffer.byteLength(answer) })
    const put = home.calls.find((call) => call.method === 'PUT')!
    assert.equal(put.path, `/api/runners/v1/attempts/${attempt}/files/submission.csv`)
    assert.equal(put.headers['content-encoding'], 'gzip')
    assert.equal(Number(put.headers['content-length']), fs.statSync(gz).size)
    assert.equal(home.stored.get(attempt)?.get('submission.csv')?.toString(), answer)
    // A mismatched header: home's 422 is a refusal, by its code.
    const wrong = await client.upload(attempt, 'submission.csv', gz, { sha256: sha256('other'), bytes: 5 })
    assert.equal(wrong.kind === 'refused' && wrong.error, 'mismatch')
  } finally {
    await home.close()
  }
})

test('a reply over the size cap is not read whole, and is a hiccup', async () => {
  const home = await fakeHome()
  const client = new RemoteClient({ home: home.url, build: 'dev', credential: () => credential })
  try {
    home.onSync = () => ({ body: Buffer.alloc(17 * 1024 * 1024, 32), headers: { 'Content-Type': 'application/json' } })
    const answer = await client.sync(syncBody())
    assert.equal(answer.kind, 'transient')
    assert.match(answer.kind === 'transient' ? answer.reason : '', /size cap/)
  } finally {
    await home.close()
  }
})

test('the backoff stays between one second and thirty, grows with each failure in a row, jitters, and starts over after a success', () => {
  const low = new Backoff(() => 0)
  const high = new Backoff(() => 0.999999)
  const lows: number[] = []
  const highs: number[] = []
  for (let i = 0; i < 10; i++) {
    lows.push(low.next())
    highs.push(high.next())
  }
  assert.ok(lows.every((ms) => ms === REMOTE_BACKOFF_MIN_MS), lows.join())
  assert.deepEqual(highs.slice(0, 4), [2000, 4000, 8000, 16000])
  assert.ok(highs.slice(4).every((ms) => ms === REMOTE_BACKOFF_MAX_MS), highs.join())
  // Full jitter, the first wait included: a fleet dropped at once does not come back at once.
  const first = new Set(Array.from({ length: 50 }, () => new Backoff().next()))
  assert.ok(first.size > 1, [...first].join())
  assert.ok([...first].every((ms) => ms >= REMOTE_BACKOFF_MIN_MS && ms <= 2 * REMOTE_BACKOFF_MIN_MS))
  // Retry-After is the least of it, within the range.
  assert.equal(new Backoff(() => 0).next(7000), 7000)
  assert.equal(new Backoff(() => 0).next(10 * 60_000), REMOTE_BACKOFF_MAX_MS)
  high.reset()
  assert.equal(high.streak, 0)
  assert.equal(high.next(), 2000)
  // Retry-After, as seconds or a date.
  assert.equal(retryAfter('12'), 12_000)
  assert.equal(retryAfter(new Date(Date.now() + 5_000).toUTCString(), Date.now()) !== null, true)
  assert.equal(retryAfter('soon'), null)
  assert.equal(retryAfter(null), null)
  // The marker header is the contract's name.
  assert.equal(REMOTE_MARKER_HEADER, 'X-Colloq-Runner-Api')
})
