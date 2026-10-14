/**
 * The doors of the machines that run submissions (§3.1, §3.2, §3.6, §4.2,
 * §6): what the router answers and how, what every other door does with a
 * machine's credential, and what comes in and goes out by hash.
 *
 * A machine is a stranger's VM. Its credential must open its router and
 * nothing else; whatever it sends back is participant data, bounded after
 * decompression and kept only when it is what it said; and what it fetches
 * by hash is reachable only through the rows that hand it out — never the
 * answers, never another competition's hidden test, never a file replaced
 * since. Each of these fails silently: a door that takes the bearer as a
 * room token, a 413 without the marker that the agent takes for the
 * relay's page and retries for ever, a gzip bomb that fills the disk, an
 * upload that recreates an erased submission's folders.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { ENTRANT_COOKIE } from '../shared/competitions.js'
import { REMOTE_API_ROOT, REMOTE_MARKER, REMOTE_MARKER_HEADER, REMOTE_PROTOCOL, REMOTE_PROTOCOL_HEADER, REMOTE_SYNC_BYTES, parseRemoteErrorReply, remoteCredential, remoteProtocolOf, remoteTransient, type RemoteLease } from '../shared/remote-runner.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { verifyToken } from '../server/src/auth.js'
import { upgradeToken } from '../server/src/socket-authorization.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { createEntrant, entrantKeyOf, getSubmission, listCompetitions, putFile, setCompetitionState } from '../server/src/competitions/store.js'
import { competitionsDir, putOpenFile, submissionDir, competitionsFs } from '../server/src/competitions/storage.js'
import { getLease, getRunner, runnerEvents, updateRunner } from '../server/src/competitions/remote/store.js'
import { forgetStock } from '../server/src/competitions/remote/want.js'
import { cancelRemote } from '../server/src/competitions/remote/release.js'
import { queueRow } from '../server/src/competitions/store.js'
import { saveCompetitionSettings } from '../server/src/competitions/settings.js'
import { db } from '../server/src/db.js'
import { activeUploads, stagedPath, stagingDir } from '../server/src/competitions/remote/upload.js'
import { openBlobStreams, resetBlobBucket, starvedLease } from '../server/src/competitions/remote/blobs.js'
import { ANSWER, Machine, close, code, competition, finished, reset, send, serve, type TestCompetition } from './_remote.mts'

useCompetitionRunner(new FakeCompetitionRunner())

after(() => close())

async function joined(options: { trusted?: boolean } = {}): Promise<Machine> {
  const m = new Machine(await serve())
  assert.equal((await m.join(code({ trusted: options.trusted }))).status, 200)
  return m
}

/** A lease of `c` on a fresh machine, acked and running. */
async function runningLease(c: TestCompetition, options: { trusted?: boolean } = {}): Promise<{ m: Machine; lease: RemoteLease }> {
  const m = await joined(options)
  const first = await m.sync()
  const ready = {
    revisions: [c.revisionId],
    data: first.body.want.data.filter((entry) => entry.competitionId === c.id && !entry.sealed).map((entry) => entry.manifest),
    sealed: first.body.want.data.filter((entry) => entry.competitionId === c.id && entry.sealed).map((entry) => entry.manifest),
    bundles: [],
  }
  const second = await m.sync({ ready })
  const lease = second.body.leases[0]
  assert.ok(lease, 'leased')
  await m.sync({ seq: lease.seq, ready, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  return { m, lease }
}

/* ------------------------------------------------------------- the marker */

test('every reply of the router carries the marker, refusals included', async () => {
  reset()
  const home = await serve()
  const m = new Machine(home)
  const answers = [
    await m.call('GET', 'nothing-here', { credential: null }),
    await m.call('POST', 'sync', { body: {}, credential: null }),
    await m.call('POST', 'join', { raw: '{not json', headers: { 'content-type': 'application/json' }, credential: null }),
    await m.call('POST', 'join', { body: { protocol: 2 }, credential: null }),
    await m.call('POST', 'join', { body: { protocol: 1, build: 'dev', code: 'a'.repeat(32), joinId: 'b'.repeat(32), facts: { version: '0.24.0', hostname: 'h', platform: 'linux/amd64', cpus: 1, memoryMb: 1, diskMb: 0, docker: '28', storage: 'overlay2', driver: null } }, credential: null }),
  ]
  for (const answer of answers) assert.equal(answer.headers.get(REMOTE_MARKER_HEADER), REMOTE_MARKER, `${answer.status} carries it`)
  assert.deepEqual(answers.map((answer) => answer.status), [404, 401, 400, 426, 403])
  assert.equal(((await answers[1].json()) as { error: string }).error, 'unauthorized')
  assert.equal(((await answers[3].json()) as { error: string }).error, 'protocol')
  assert.equal(((await answers[4].json()) as { error: string }).error, 'code')
  // A body over its cap: refused as too_large, with the marker, before it is parsed.
  const machine = await joined()
  const big = await machine.call('POST', 'sync', { raw: JSON.stringify({ pad: 'x'.repeat(REMOTE_SYNC_BYTES) }), headers: { 'content-type': 'application/json' } })
  assert.equal(big.status, 413)
  assert.equal(big.headers.get(REMOTE_MARKER_HEADER), REMOTE_MARKER)
  assert.equal(((await big.json()) as { error: string }).error, 'too_large')
})

test('a machine of another protocol is told so, with the marker: never the app\'s unmarked page it would retry for ever', async () => {
  reset()
  const home = await serve()
  const m = await joined()
  // This version's replies say which protocol home speaks, beside the marker.
  const own = await m.call('POST', 'sync', { body: {} })
  assert.equal(own.headers.get(REMOTE_PROTOCOL_HEADER), String(REMOTE_PROTOCOL))
  // An agent of another release calls its own version's path, credential and all.
  for (const [method, path] of [['POST', 'v2/sync'], ['PUT', `v2/attempts/${'c'.repeat(32)}/files/submission.csv`], ['POST', 'v0/join'], ['GET', 'v17/blobs/x']] as const) {
    const answer = await fetch(`${home}${REMOTE_API_ROOT}/${path}`, {
      method,
      headers: { authorization: `Bearer ${m.credential}`, 'content-type': 'application/json', 'x-forwarded-for': m.address },
      body: method === 'GET' ? undefined : '{"protocol":2}',
    })
    assert.equal(answer.status, 426, path)
    assert.equal(answer.headers.get(REMOTE_MARKER_HEADER), REMOTE_MARKER, `${path}: marked`)
    assert.equal(remoteProtocolOf(answer.headers.get(REMOTE_PROTOCOL_HEADER)), REMOTE_PROTOCOL, `${path}: names the protocol home speaks`)
    assert.equal(remoteTransient(answer.status, answer.headers.get(REMOTE_MARKER_HEADER)), false, `${path}: final, not a hiccup`)
    assert.equal(parseRemoteErrorReply(await answer.json()).error, 'protocol')
  }
  // Not a version at all: none of the machines' business, left to the rest of the app.
  const other = await fetch(`${home}${REMOTE_API_ROOT}/status`)
  assert.equal(other.headers.get(REMOTE_MARKER_HEADER), null)
  await other.arrayBuffer()
})

/* --------------------------------------------------------- the credential */

test('a machine\'s credential opens no other door: staff, participant, room token, WebSocket', async () => {
  reset()
  const home = await serve()
  const m = await joined()
  const bearer = `Bearer ${m.credential}`

  // Staff: a valid owner cookie riding next to the machine's credential opens nothing.
  const owner = createTeacher({ name: 'Владелица', email: `owner.machines.${Date.now()}@example.edu`, role: 'owner' })!
  rotateLinkKey(owner.id)
  let cookie = ''
  issueStaffCookie({ cookie: (_name: string, value: string) => (cookie = value) } as unknown as ExpressResponse, owner)
  const staff = `${STAFF_COOKIE}=${cookie}`
  assert.equal((await fetch(`${home}/api/admin/runners`, { headers: { cookie: staff } })).status, 200, 'the cookie alone is the owner')
  assert.equal((await fetch(`${home}/api/admin/runners`, { headers: { cookie: staff, authorization: bearer } })).status, 401, 'with the machine\'s credential it is a machine')

  // Participant: the same.
  const entrant = createEntrant(`машинный-участник-${Date.now()}`)
  const signIn = await fetch(`${home}/api/k/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: entrantKeyOf(entrant.entrant.id) }) })
  const entrantCookie = signIn.headers.getSetCookie().find((line) => line.startsWith(`${ENTRANT_COOKIE}=`))!.split(';')[0]
  const me = async (headers: Record<string, string>) => ((await (await fetch(`${home}/api/k/me`, { headers })).json()) as { entrant: unknown }).entrant
  assert.ok(await me({ cookie: entrantCookie }))
  assert.equal(await me({ cookie: entrantCookie, authorization: bearer }), null)

  // The room token check and the socket upgrade.
  assert.equal(verifyToken(m.credential), null)
  assert.equal(upgradeToken({ authorization: bearer }, 'anything.signed'), null)
  assert.equal(upgradeToken({}, m.credential), null)
  assert.equal(upgradeToken({}, 'body.sig'), 'body.sig', 'a room token passes on to verifyToken as before')

  // And the router takes nothing but its own credential: the owner's cookie is no machine.
  assert.equal((await m.call('POST', 'sync', { body: {}, credential: null, headers: { cookie: staff } })).status, 401)
})

test('a wrong secret, a revoked machine and one that left are all refused alike', async () => {
  reset()
  const m = await joined()
  assert.equal((await m.sync()).status, 200)
  const wrong = remoteCredential(m.runnerId, 'f'.repeat(64))
  assert.equal((await m.call('POST', 'sync', { body: {}, credential: wrong })).status, 401)
  const { revokeRunner } = await import('../server/src/competitions/remote/release.js')
  revokeRunner(m.runnerId)
  assert.equal((await m.sync()).status, 401)
  const leaving = await joined()
  assert.equal((await leaving.sync({ state: 'leaving' })).status, 200, 'the leave is answered')
  assert.equal(getRunner(leaving.runnerId)?.state, 'left')
  assert.equal((await leaving.sync()).status, 401, 'and from then on refused')
})

test('a machine that leaves is answered at once, and an offer it never heard is free for others at once', async () => {
  reset()
  const c = competition()
  const s = send(c)
  const m = await joined()
  const first = await m.sync()
  const ready = { revisions: [c.revisionId], data: first.body.want.data.filter((entry) => entry.competitionId === c.id && !entry.sealed).map((entry) => entry.manifest), sealed: [], bundles: [] }
  const offer = (await m.sync({ ready })).body.leases[0]
  assert.ok(offer, 'leased')
  // The reply that carried the offer was lost on the way: the leaving sync has not seen its number.
  assert.equal((await m.sync({ state: 'leaving', seq: 0, ready })).status, 200)
  assert.equal(getLease(offer.attemptId)?.state, 'withdrawn', 'the offer goes with the machine, counted against nobody')
  assert.equal(queueRow(s.id)?.state, 'waiting', 'and its row waits for another executor now, not in a minute')
  assert.equal(queueRow(s.id)?.lost, 0)

  // A machine drained by the owner with nothing to hold: the leave is the only news its reply has.
  const live = listCompetitions().filter((one) => one.state === 'live')
  for (const one of live) setCompetitionState(one.id, 'draft')
  try {
    reset()
    const quiet = await joined()
    assert.deepEqual((await quiet.sync()).body.want.data, [])
    updateRunner(quiet.runnerId, { state: 'draining' })
    assert.equal((await quiet.sync()).body.drain, true)
    const started = Date.now()
    assert.equal((await quiet.sync({ state: 'leaving', holdMs: 25_000 })).status, 200)
    assert.ok(Date.now() - started < 5_000, `the leave is not held (${Date.now() - started} ms)`)
    assert.equal(getRunner(quiet.runnerId)?.state, 'left')
  } finally {
    for (const one of live) setCompetitionState(one.id, 'live')
    forgetStock()
  }
})

/* ---------------------------------------------------------------- joining */

test('a code joins its number of machines, a repeated join is the same machine with a new secret, and an old code is refused', async () => {
  reset()
  const home = await serve()
  const once = code({ machines: 1, approvedSlots: 3, trusted: true })
  const first = new Machine(home)
  assert.equal((await first.join(once)).status, 200)
  const secret = first.secret
  assert.equal(getRunner(first.runnerId)?.trusted, true, 'the code\'s trust is carried')
  assert.equal(getRunner(first.runnerId)?.approvedSlots, 3, 'and its cap')
  // Its reply was lost: the same joinId again, the code already used up.
  const again = new Machine(home)
  Object.assign(again, { joinId: first.joinId })
  assert.equal((await again.join(once)).status, 200)
  assert.equal(again.runnerId, first.runnerId, 'the same machine')
  assert.notEqual(again.secret, secret, 'with a new secret')
  assert.equal((await first.sync()).status, 401, 'the old one is refused')
  assert.equal((await again.sync()).status, 200)
  // Another machine on a used-up code: refused.
  assert.equal((await new Machine(home).join(once)).status, 403)
  // The same joinId with a different code: refused, and no second machine.
  const other = new Machine(home)
  Object.assign(other, { joinId: first.joinId })
  assert.equal((await other.join(code())).status, 403)
  // After the repeat window: refused.
  db.prepare('UPDATE remote_runners SET created_at = created_at - 11 * 60000 WHERE id = ?').run(first.runnerId)
  assert.equal((await again.join(once)).status, 403)
  // An expired code: refused.
  const late = code()
  db.prepare('UPDATE remote_runner_codes SET expires_at = ?').run(Date.now() - 1)
  assert.equal((await new Machine(home).join(late)).status, 403)
})

test('joins are the router\'s one limit by address: ten per ten minutes, then 429 with Retry-After', async () => {
  reset()
  const home = await serve()
  const statuses: number[] = []
  for (let i = 0; i < 11; i++) {
    const m = new Machine(home)
    m.address = '203.0.113.77'
    statuses.push((await m.join('0'.repeat(32))).status)
  }
  assert.deepEqual(statuses, [...Array(10).fill(403), 429])
  // Another address is not held up by that one.
  const other = new Machine(home)
  other.address = '203.0.113.78'
  assert.equal((await other.join(code())).status, 200)
})

test('a machine\'s calls are limited per machine, never per address: its 241st sync in a minute waits', async () => {
  reset()
  const m = await joined()
  const neighbour = await joined()
  neighbour.address = m.address
  let refused = 0
  for (let i = 0; i < 241; i++) if ((await m.sync()).status === 429) refused++
  assert.equal(refused, 1)
  assert.equal((await neighbour.sync()).status, 200, 'a machine behind the same address is not held up')
})

test('the code is kept only by its sha256', () => {
  const minted = code()
  const rows = db.prepare('SELECT code_sha256 FROM remote_runner_codes').all() as { code_sha256: string }[]
  assert.ok(rows.some((row) => row.code_sha256 === createHash('sha256').update(minted).digest('hex')))
  const dump = JSON.stringify(db.prepare('SELECT * FROM remote_runner_codes').all())
  assert.ok(!dump.includes(minted), 'nowhere in clear')
})

/* ------------------------------------------------------------------ blobs */

test('blobs by hash: in scope only, the hidden test to trusted machines only, Range, and 410 once replaced', async () => {
  reset()
  const c = competition({ sealed: true })
  // A train.csv of its own: every competition of these tests has the same one, and a hash another competition still holds is no gone file.
  const own = putOpenFile(c.id, 'train.csv', new TextEncoder().encode(`id,feature\n1,${c.id}\n2,0.7\n`))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: own.bytes, visibility: 'open', sha256: own.sha256 })
  forgetStock()
  send(c)
  const untrusted = await joined()
  const trusted = await joined({ trusted: true })
  const plainWant = (await untrusted.sync()).body.want
  const open = plainWant.data.find((entry) => entry.competitionId === c.id && !entry.sealed)!
  assert.equal(plainWant.data.some((entry) => entry.sealed), false, 'an untrusted machine is not even told of the hidden test')
  const train = open.files.find((file) => file.name === 'train.csv')!
  const blob = await untrusted.call('GET', `blobs/${train.sha256}`)
  assert.equal(blob.status, 200)
  assert.equal(blob.headers.get('etag'), `"${train.sha256}"`)
  assert.equal(createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex'), train.sha256)
  const part = await untrusted.call('GET', `blobs/${train.sha256}`, { headers: { range: 'bytes=3-' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), `bytes 3-${train.bytes - 1}/${train.bytes}`)
  assert.equal(Buffer.from(await part.arrayBuffer()).length, train.bytes - 3)

  const trustedWant = (await trusted.sync()).body.want
  const sealed = trustedWant.data.find((entry) => entry.competitionId === c.id && entry.sealed)!
  const hidden = sealed.files[0]
  assert.equal((await untrusted.call('GET', `blobs/${hidden.sha256}`)).status, 404, 'the hidden test is out of an untrusted machine\'s scope')
  assert.equal((await trusted.call('GET', `blobs/${hidden.sha256}`)).status, 200)
  assert.ok(runnerEvents(trusted.runnerId).some((event) => event.kind === 'sealed_fetched'), 'and its fetch is in the machine\'s log')

  // The answers and the metric are no blob, whatever hash is guessed.
  const solution = createHash('sha256').update('id,target\n1,1\n2,2\n').digest('hex')
  const metric = createHash('sha256').update(`${c.metric.code}\n`).digest('hex')
  for (const guess of [solution, metric, 'e'.repeat(64)]) assert.equal((await trusted.call('GET', `blobs/${guess}`)).status, 404)

  // Replaced since: 410, and the next want names the new file.
  const stored = putOpenFile(c.id, 'train.csv', new TextEncoder().encode('id,feature\n1,9\n'))
  putFile({ competitionId: c.id, name: 'train.csv', bytes: stored.bytes, visibility: 'open', sha256: stored.sha256 })
  assert.equal((await untrusted.call('GET', `blobs/${train.sha256}`)).status, 410)
})

test('a file two competitions share, replaced in one of them, is still served from the other: never 410 for a hash a machine still needs', async () => {
  reset()
  const first = competition()
  const second = competition()
  const bytes = new TextEncoder().encode(`id,feature\n1,shared-${first.id}\n`)
  for (const c of [first, second]) {
    const stored = putOpenFile(c.id, 'shared.csv', bytes)
    putFile({ competitionId: c.id, name: 'shared.csv', bytes: stored.bytes, visibility: 'open', sha256: stored.sha256 })
    send(c)
  }
  forgetStock()
  const m = await joined()
  const want = (await m.sync()).body.want
  const shared = want.data.find((entry) => entry.competitionId === first.id)!.files.find((file) => file.name === 'shared.csv')!
  assert.ok(want.data.find((entry) => entry.competitionId === second.id)!.files.some((file) => file.sha256 === shared.sha256))
  // The second competition replaces its copy; the first keeps the very same bytes, which the machine still needs for it.
  for (const c of [second, first]) {
    const replaced = putOpenFile(c.id, 'shared.csv', new TextEncoder().encode(`id,feature\n1,new-${c.id}\n`))
    putFile({ competitionId: c.id, name: 'shared.csv', bytes: replaced.bytes, visibility: 'open', sha256: replaced.sha256 })
    const answer = await m.call('GET', `blobs/${shared.sha256}`)
    const body = Buffer.from(await answer.arrayBuffer())
    if (c === second) {
      assert.equal(answer.status, 200, 'served from the competition that still has it')
      assert.equal(createHash('sha256').update(body).digest('hex'), shared.sha256)
    } else assert.equal(answer.status, 410, 'once neither has it, it is gone')
  }
})

test('one blob stream per machine: its newer request replaces the stream it let go, and is never told to come back for it', async () => {
  reset()
  resetBlobBucket()
  saveCompetitionSettings({ runnerBlobMBps: 1 })
  try {
    const c = competition()
    const big = Buffer.alloc(3 * 1024 * 1024, 7)
    const stored = putOpenFile(c.id, 'big.bin', big)
    putFile({ competitionId: c.id, name: 'big.bin', bytes: stored.bytes, visibility: 'open', sha256: stored.sha256 })
    send(c)
    const m = await joined()
    await m.sync()
    const first = await m.call('GET', `blobs/${stored.sha256}`)
    assert.equal(first.status, 200)
    const old = first.body!.getReader()
    await old.read()
    // The agent runs one stream at a time: its next request means it let the first go (cache.ts · enqueue preempting a prefetch).
    const second = await m.call('GET', `blobs/${stored.sha256}`)
    assert.equal(second.status, 200, 'its own new request is served, not 429')
    assert.equal(openBlobStreams(m.runnerId), 1, 'and it still holds one stream')
    let rest = 0
    let cut = false
    try {
      for (;;) {
        const { done, value } = await old.read()
        if (done) break
        rest += value.length
      }
    } catch {
      cut = true
    }
    assert.ok(cut || rest < big.length, 'the stream it let go is ended')
    const started = Date.now()
    const body = Buffer.from(await second.arrayBuffer())
    assert.equal(body.length, big.length)
    // Three megabytes at one a second, a quarter-second burst aside.
    assert.ok(Date.now() - started >= 1500, 'the owner\'s rate holds')
  } finally {
    saveCompetitionSettings({ runnerBlobMBps: null })
    resetBlobBucket()
  }
})

test('three blob streams for the whole server: prefetch takes two, the third is for a lease\'s own blobs, and a lease takes a prefetch\'s place when all are taken', async () => {
  reset()
  resetBlobBucket()
  saveCompetitionSettings({ runnerBlobMBps: 1 })
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
  try {
    const c = competition()
    const big = Buffer.alloc(2 * 1024 * 1024, 5)
    const stored = putOpenFile(c.id, 'big.bin', big)
    putFile({ competitionId: c.id, name: 'big.bin', bytes: stored.bytes, visibility: 'open', sha256: stored.sha256 })
    // Notebooks with saved outputs, a megabyte and a half each: they ride by hash, and their streams last.
    const heavy = ['x = 1', `# ${'o'.repeat(1536 * 1024)}`]
    for (let i = 0; i < 4; i++) send(c, { cells: heavy, at: Date.now() - 10_000 + i })
    const prefetchers = [await joined(), await joined(), await joined()]
    for (const one of prefetchers) await one.sync()
    for (const one of prefetchers.slice(0, 2)) {
      const open = await one.call('GET', `blobs/${stored.sha256}`)
      assert.equal(open.status, 200)
      readers.push(open.body!.getReader())
      await readers.at(-1)!.read()
    }
    const third = await prefetchers[2].call('GET', `blobs/${stored.sha256}`)
    assert.equal(third.status, 429, 'prefetch never takes the stream kept for leases')
    assert.ok(Number(third.headers.get('retry-after')) > 0)
    await third.arrayBuffer()
    // Machines with a lease each: the first is served on the stream kept for leases, the second takes a prefetcher's place.
    const holders: Array<{ m: Machine; lease: RemoteLease }> = []
    for (let i = 0; i < 4; i++) {
      const m = await joined()
      const first = await m.sync()
      const data = first.body.want.data.find((entry) => entry.competitionId === c.id && !entry.sealed)!
      const leased = await m.sync({ ready: { revisions: [c.revisionId], data: [data.manifest], sealed: [], bundles: [] }, free: { slots: 1, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 } })
      const lease = leased.body.leases[0]
      assert.ok(lease, 'leased')
      // Acked with no place left: one lease each.
      await m.sync({ seq: lease.seq, ready: { revisions: [c.revisionId], data: [data.manifest], sealed: [], bundles: [] }, free: { slots: 0, memoryMb: 28_000, cpus: 14, gpuShares: 0, diskMb: 99_000 }, attempts: [{ id: lease.attemptId, phase: 'preparing' }] })
      holders.push({ m, lease })
    }
    const own = async (holder: { m: Machine; lease: RemoteLease }) => holder.m.call('GET', `blobs/${holder.lease.notebook.sha256}`)
    const kept = await own(holders[0])
    assert.equal(kept.status, 200, 'a lease\'s blob on the stream prefetch leaves it')
    readers.push(kept.body!.getReader())
    await readers.at(-1)!.read()
    const preempting = await own(holders[1])
    assert.equal(preempting.status, 200, 'and with every stream taken, in a prefetcher\'s place')
    readers.push(preempting.body!.getReader())
    await readers.at(-1)!.read()
    assert.equal(openBlobStreams(), 3)
    const third2 = await own(holders[2])
    assert.equal(third2.status, 200, 'the other prefetcher\'s place too')
    readers.push(third2.body!.getReader())
    await readers.at(-1)!.read()
    // Every stream a lease's now: the next lease is told to come back, and its wait is this server's, not the machine's (blobs.ts · starvedLease).
    const fourth = await own(holders[3])
    assert.equal(fourth.status, 429)
    await fourth.arrayBuffer()
    assert.equal(starvedLease(holders[3].lease.attemptId), true)
    assert.equal(starvedLease(holders[0].lease.attemptId), false)
  } finally {
    for (const reader of readers) await reader.cancel().catch(() => undefined)
    saveCompetitionSettings({ runnerBlobMBps: null })
    resetBlobBucket()
  }
})

/* ---------------------------------------------------------------- uploads */

test('an upload is kept only when it is what its headers said, bounded after decompression, under one of two names', async () => {
  reset()
  const c = competition()
  send(c)
  const { m, lease } = await runningLease(c)
  const staged = () => (fs.existsSync(stagingDir(lease.attemptId)) ? fs.readdirSync(stagingDir(lease.attemptId)) : [])
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER, { sha256: 'a'.repeat(64) })).status, 422, 'a wrong hash')
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER, { bytes: String(ANSWER.length + 1) })).status, 422, 'a wrong length')
  // A gzip bomb: a few kilobytes that inflate to megabytes, declared as ten bytes.
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024))
  assert.equal((await m.put(lease.attemptId, 'submission.csv', 'x', { raw: bomb, bytes: '10', sha256: 'b'.repeat(64) })).status, 413)
  assert.equal((await m.put(lease.attemptId, 'submission.csv', 'x', { bytes: String(65 * 1024 * 1024) })).status, 413, 'declared over its cap: refused before a byte is read')
  assert.equal((await m.put(lease.attemptId, 'run.json', '{}')).status, 400, 'nothing but the two names')
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER, { encoding: 'identity' })).status, 400, 'gzip only')
  assert.deepEqual(staged().filter((name) => !name.endsWith('.part')), [], 'nothing kept of any of them')
  const ok = await m.put(lease.attemptId, 'submission.csv', ANSWER)
  assert.equal(ok.status, 200)
  assert.equal((ok.body as { sha256: string }).sha256, createHash('sha256').update(ANSWER).digest('hex'))
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200, 'the same again: a no-op')
  assert.equal(staged().filter((name) => name.startsWith('submission.csv.')).length, 1)
})

test('an upload refused in the middle of its body is answered, marked: never a reset the machine retries for ever', async () => {
  reset()
  const c = competition()
  send(c)
  const { m, lease } = await runningLease(c)
  /** A PUT whose body is megabytes of `chunk()`, sent as it is read: still on its way when home finds what is wrong with it. */
  let pulled = 0
  const streamed = (headers: Record<string, string>, chunk: () => Uint8Array, chunks: number) => {
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ >= chunks) controller.close()
        else {
          pulled++
          controller.enqueue(chunk())
        }
      },
    })
    return fetch(`${m.home}/api/runners/v1/attempts/${lease.attemptId}/files/submission.csv`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${m.credential}`, 'x-forwarded-for': m.address, ...headers },
      body,
      duplex: 'half',
    } as RequestInit)
  }
  const random = () => new Uint8Array(createHash('sha256').update(String(Math.random())).digest().buffer.slice(0)).subarray(0, 32)
  const noise = () => {
    const out = new Uint8Array(64 * 1024)
    for (let i = 0; i < out.length; i += 32) out.set(random(), i)
    return out
  }
  // Not gzip at all: gunzip refuses its first bytes, with sixteen megabytes still to come.
  const notGzip = await streamed({ 'content-encoding': 'gzip', 'x-colloq-sha256': 'a'.repeat(64), 'x-colloq-bytes': String(16 * 1024 * 1024) }, noise, 256)
  assert.equal(notGzip.status, 422)
  assert.equal(notGzip.headers.get(REMOTE_MARKER_HEADER), REMOTE_MARKER)
  assert.equal(parseRemoteErrorReply(await notGzip.json()).error, 'mismatch')
  // Gzip that inflates past what it declared, found after its first chunk of many.
  const big = zlib.gzipSync(Buffer.concat(Array.from({ length: 48 }, () => Buffer.from(noise()))))
  let at = 0
  const slices = () => {
    const part = big.subarray(at, at + 64 * 1024)
    at += part.length
    return new Uint8Array(part)
  }
  const longer = await streamed({ 'content-encoding': 'gzip', 'x-colloq-sha256': 'b'.repeat(64), 'x-colloq-bytes': '1000' }, slices, Math.ceil(big.length / (64 * 1024)))
  assert.equal(longer.status, 413)
  assert.equal(longer.headers.get(REMOTE_MARKER_HEADER), REMOTE_MARKER)
  assert.equal(parseRemoteErrorReply(await longer.json()).error, 'too_large')
  assert.equal(activeUploads(), 0, 'and its place among the uploads is free again')
  // A refusal before a byte of the body is read (an attempt cancelled meanwhile): answered at once, the body let go of rather than drained.
  const { cancelRemote } = await import('../server/src/competitions/remote/release.js')
  assert.equal(cancelRemote(queueRow(lease.submissionId)!, 'teacher'), true)
  const started = Date.now()
  pulled = 0
  const late = await streamed({ 'content-encoding': 'gzip', 'x-colloq-sha256': 'c'.repeat(64), 'x-colloq-bytes': '100' }, noise, 1024)
  assert.equal(late.status, 409)
  // Counted in chunks, not milliseconds, which a loaded runner stretches: a body home does not read stops at what the
  // sockets' buffers hold, a few megabytes, while one it drained would have been sent whole before the answer.
  assert.ok(pulled < 512, `answered before the sixty-four megabytes were sent (${pulled} of 1024 chunks, ${Date.now() - started} ms)`)
  assert.ok(Date.now() - started < 10_000, `answered at once, not after a timeout (${Date.now() - started} ms)`)
  assert.equal(parseRemoteErrorReply(await late.json()).error, 'revoked')
})

test('two uploads of one file at once write a file each: what is kept is one whole write, never two halves', async () => {
  reset()
  const c = competition()
  send(c)
  const { m, lease } = await runningLease(c)
  const content = Buffer.from(Array.from({ length: 4096 }, (_, i) => `${i},${createHash('sha256').update(String(i)).digest('hex')}\n`).join(''))
  const gz = zlib.gzipSync(content)
  const sha = createHash('sha256').update(content).digest('hex')
  const headers = { authorization: `Bearer ${m.credential}`, 'content-encoding': 'gzip', 'x-colloq-sha256': sha, 'x-colloq-bytes': String(content.length) }
  /** A PUT whose body is sent as `first`, then the rest when the test says so. */
  const streamed = (first: Buffer) => {
    let finish: (more: Buffer | null) => void = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(first))
        finish = (more) => {
          if (more) controller.enqueue(new Uint8Array(more))
          controller.close()
        }
      },
    })
    const answer = fetch(`${m.home}/api/runners/v1/attempts/${lease.attemptId}/files/submission.csv`, { method: 'PUT', headers, body, duplex: 'half' } as RequestInit)
    return { answer, rest: (more: Buffer | null) => finish(more) }
  }
  const until = async (what: () => boolean) => {
    const deadline = Date.now() + 5_000
    while (!what()) {
      assert.ok(Date.now() < deadline, 'in time')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const dir = stagingDir(lease.attemptId)
  const parts = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.part')) : [])
  const half = Math.floor(gz.length / 2)
  // The first PUT is half written...
  const first = streamed(gz.subarray(0, half))
  await until(() => parts().some((name) => fs.statSync(path.join(dir, name)).size > 0))
  // ...when the machine's retry of it starts (the relay kept the first alive).
  const second = streamed(gz.subarray(0, 10))
  await until(() => activeUploads() === 2)
  first.rest(gz.subarray(half))
  const done = await first.answer
  await done.arrayBuffer()
  assert.equal(done.status, 200)
  const kept = fs.readFileSync(stagedPath(lease.attemptId, 'submission.csv', sha))
  assert.equal(createHash('sha256').update(kept).digest('hex'), sha, 'the file kept is the file, whole')
  // The retry, cut short, leaves nothing of its own behind.
  second.rest(null)
  const cut = await second.answer
  await cut.arrayBuffer()
  assert.equal(cut.status, 422)
  await until(() => parts().length === 0)
  assert.deepEqual(fs.readdirSync(dir), [`submission.csv.${sha}`])
})

test('an upload for another machine\'s attempt is not found, and one for a cancelled or erased run creates nothing', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const { m, lease } = await runningLease(c)
  const stranger = await joined()
  assert.equal((await stranger.put(lease.attemptId, 'submission.csv', ANSWER)).status, 404)
  // Cancelled (the teacher's kill), then erased with its folder: a late upload recreates neither.
  assert.equal(cancelRemote(queueRow(sent.id)!, 'teacher'), true)
  assert.equal(getLease(lease.attemptId)?.state, 'revoked')
  competitionsFs.rmSync(submissionDir(c.id, sent.id), { recursive: true, force: true })
  const late = await m.put(lease.attemptId, 'submission.csv', ANSWER)
  assert.equal(late.status, 409)
  assert.equal((late.body as { error: string }).error, 'revoked')
  assert.equal(fs.existsSync(submissionDir(c.id, sent.id)), false, 'no folder of the erased submission came back')
  assert.equal(fs.existsSync(stagingDir(lease.attemptId)), false)
  const outcome = await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]))
  assert.equal((outcome.body as { result: string }).result, 'revoked')
  assert.equal(getSubmission(sent.id)?.state, 'cancelled')
})

test('uploads past their limit are told to come back, and below the disk floor told the disk is full', async () => {
  reset()
  const c = competition()
  send(c)
  const { m, lease } = await runningLease(c)
  saveCompetitionSettings({ runnerUploads: 1 })
  // One upload whose body never ends holds the only place.
  let release: () => void = () => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(zlib.gzipSync(Buffer.from('id,'))).subarray(0, 5))
      release = () => controller.close()
    },
  })
  const held = fetch(`${m.home}/api/runners/v1/attempts/${lease.attemptId}/files/executed.ipynb`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${m.credential}`, 'content-encoding': 'gzip', 'x-colloq-sha256': 'c'.repeat(64), 'x-colloq-bytes': '100' },
    body,
    duplex: 'half',
  } as RequestInit)
  await new Promise((resolve) => setTimeout(resolve, 200))
  try {
    const busy = await m.put(lease.attemptId, 'submission.csv', ANSWER)
    assert.equal(busy.status, 503)
    assert.equal((busy.body as { error: string }).error, 'busy')
    assert.ok(Number(busy.headers.get('retry-after')) > 0)
  } finally {
    release()
    await held.then((answer) => answer.arrayBuffer()).catch(() => undefined)
    saveCompetitionSettings({ runnerUploads: null })
  }
  const statfs = fs.statfsSync
  ;(fs as { statfsSync: typeof fs.statfsSync }).statfsSync = ((target: fs.PathLike) => ({ ...statfs(target), bavail: 1, bsize: 4096 })) as typeof fs.statfsSync
  try {
    const full = await m.put(lease.attemptId, 'submission.csv', ANSWER)
    assert.equal(full.status, 507)
    assert.equal((full.body as { error: string }).error, 'disk')
  } finally {
    ;(fs as { statfsSync: typeof fs.statfsSync }).statfsSync = statfs
  }
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  void competitionsDir
  void path
})
