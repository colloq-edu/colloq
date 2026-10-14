/**
 * This server's side of the machines against what the second review showed
 * (competitions/remote/, routes/admin-runners.ts, the forecast's fleet, the
 * doors): each test is one finding as it happened — an owner who cannot close
 * a leaked code, a hidden test still flowing after an untrust, a machine
 * staging gigabytes under one lease, a descriptor closed under a queued
 * write, a silence counted through an outage, a rollback's leases left
 * live, places counted in runs no competition has — and what must hold now.
 *
 * No Docker and no machine: the real app over HTTP, a stand-in agent that
 * speaks the contract (tests/_remote.mts), and a clock moved by hand.
 */
import './_env.mts'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE, type ResourceSettingsResponse } from '../shared/admin.js'
import { ENTRANT_COOKIE } from '../shared/competitions.js'
import type { EntrantSubmissions } from '../shared/competitions-entrant.js'
import type { MintRemoteCodeResponse, RemoteMachinesResponse } from '../shared/remote-admin.js'
import type { CompetitionLive, CompetitionView, QueueSnapshot } from '../shared/competitions-api.js'
import {
  REMOTE_API_BASE,
  REMOTE_BYTES_HEADER,
  REMOTE_DECLINE_SKIP_MS,
  REMOTE_RUNNERS_KEEP_MS,
  REMOTE_SHA256_HEADER,
  REMOTE_SILENCE_MS,
  type RemoteLease,
  type RemoteOutcomeReply,
} from '../shared/remote-runner.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { listAdminEvents } from '../server/src/admin/audit-log.js'
import { FakeCompetitionRunner } from '../server/src/competitions/fake-runner.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { createCapabilityReader, notebookNeeds } from '../server/src/competitions/capabilities.js'
import { queueForecast } from '../server/src/competitions/forecast.js'
import { BOOT, entrantKeyOf, getSubmission, listRuns, putFile, queueRow, queueRows, reclaimQueue, updateCompetition } from '../server/src/competitions/store.js'
import { putOpenFile, putSealedFile } from '../server/src/competitions/storage.js'
import { saveCompetitionSettings, scoreSlotsSetting, competitionDefaults } from '../server/src/competitions/settings.js'
import { bindSubmission, competitionRevision, completeBundle, createBundle, setPolicy } from '../server/src/dependencies/store.js'
import {
  endRemoteCode,
  getLease,
  getRunner,
  joinRunner,
  pruneRemoteRows,
  runnerEvents,
  updateLease,
  updateRunner,
  type RunnerRow,
} from '../server/src/competitions/remote/store.js'
import { runnerOffer, takeForRunner } from '../server/src/competitions/remote/lease.js'
import { declineLease, loseLease, revokeRunner, untrustRunner } from '../server/src/competitions/remote/release.js'
import { bootRemoteRunners, leavesHost, probeOwnPath, remoteTick, settleUnfit } from '../server/src/competitions/remote/liveness.js'
import { noteCall, noteProbe, noteSync, resetHeard } from '../server/src/competitions/remote/heard.js'
import { forgetWantScope, markStarved, openBlobStreams, resetBlobBucket, starvedLease, useBlobStallMs } from '../server/src/competitions/remote/blobs.js'
import { activeUploads, stagingDir, useUploadStallMs } from '../server/src/competitions/remote/upload.js'
import { dataNow, forgetStock, homeStock, runnerWant } from '../server/src/competitions/remote/want.js'
import { placeMix, remoteFleet, runningRemote, waitReasons, blocking } from '../server/src/competitions/remote/views.js'
import { db } from '../server/src/db.js'
import { ANSWER, FACTS, Machine, close, code, competition, finished, portableRevision, reset, send, serve, syncRequest, type TestCompetition } from './_remote.mts'

useCompetitionRunner(new FakeCompetitionRunner())

after(() => close())

/* ---------------------------------------------------------------- helpers */

function staff(role: 'owner' | 'teacher'): { cookie: string; name: string } {
  const name = role === 'owner' ? 'Владелица кодов' : 'Преподаватель кодов'
  const made = createTeacher({ name, email: `${role}.r2.${Date.now()}.${Math.random()}@example.edu`, role })!
  rotateLinkKey(made.id)
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, made)
  return { cookie: `${STAFF_COOKIE}=${value}`, name }
}

const owner = staff('owner')
const teacher = staff('teacher')

async function admin<T>(method: string, at: string, options: { body?: unknown; cookie?: string } = {}): Promise<{ status: number; body: T }> {
  const home = await serve()
  const answer = await fetch(`${home}${at}`, {
    method,
    headers: { cookie: options.cookie ?? owner.cookie, ...(options.body !== undefined && method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
    body: options.body === undefined || method === 'GET' ? undefined : JSON.stringify(options.body),
  })
  const text = await answer.text()
  return { status: answer.status, body: (text ? JSON.parse(text) : null) as T }
}

async function joined(options: { trusted?: boolean; approvedSlots?: number | null } = {}): Promise<Machine> {
  const m = new Machine(await serve())
  assert.equal((await m.join(code({ trusted: options.trusted, approvedSlots: options.approvedSlots }))).status, 200)
  return m
}

/** What a machine reports in place for these competitions, from what its first sync is asked to hold. */
async function readyFor(m: Machine, competitions: TestCompetition[]) {
  const first = await m.sync()
  const ids = new Set(competitions.map((c) => c.id))
  return {
    revisions: competitions.map((c) => c.revisionId),
    data: [...new Set(first.body.want.data.filter((entry) => ids.has(entry.competitionId) && !entry.sealed).map((entry) => entry.manifest))],
    sealed: [...new Set(first.body.want.data.filter((entry) => ids.has(entry.competitionId) && entry.sealed).map((entry) => entry.manifest))],
    bundles: [],
  }
}

const FREE = (slots: number) => ({ slots, memoryMb: 32_768, cpus: 16, gpuShares: 0, diskMb: 100_000 })

/** One lease of `c` on `m`, acked as running (or preparing). */
async function leaseOn(m: Machine, c: TestCompetition, phase: 'running' | 'preparing' = 'running'): Promise<{ lease: RemoteLease; ready: Awaited<ReturnType<typeof readyFor>> }> {
  const ready = await readyFor(m, [c])
  const leased = await m.sync({ ready, free: FREE(1) })
  const lease = leased.body.leases[0]
  assert.ok(lease, 'leased')
  await m.sync({ seq: lease.seq, ready, free: FREE(0), attempts: [{ id: lease.attemptId, phase, ...(phase === 'running' ? { runningMs: 0 } : {}) }] })
  return { lease, ready }
}

function machineRow(): RunnerRow {
  const made = joinRunner({ code: code(), joinId: randomUUID().replaceAll('-', ''), build: 'dev', facts: FACTS, address: null }, Date.now())
  assert.ok(made.ok)
  return made.runner
}

function offerFor(runner: RunnerRow, c: TestCompetition, over: Partial<ReturnType<typeof syncRequest>> = {}) {
  const sets = dataNow(c.id)
  const sync = syncRequest({ ready: { revisions: [c.revisionId], data: sets.open ? [sets.open.manifest] : [], sealed: [], bundles: [] }, ...over })
  return runnerOffer(getRunner(runner.id)!, sync.free, sync)
}

/** A PUT whose body sends five bytes of gzip and then nothing, until `release`. */
function stalledPut(home: string, m: Machine, attemptId: string): { answer: Promise<Response>; release: () => void } {
  let close: () => void = () => undefined
  const head = zlib.gzipSync(Buffer.alloc(1024 * 1024)).subarray(0, 5)
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(head))
      close = () => {
        try {
          controller.close()
        } catch {
          // Ended already: the server let it go.
        }
      }
    },
  })
  const answer = fetch(`${home}${REMOTE_API_BASE}/attempts/${attemptId}/files/executed.ipynb`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${m.credential}`, 'content-encoding': 'gzip', [REMOTE_SHA256_HEADER]: 'c'.repeat(64), [REMOTE_BYTES_HEADER]: String(1024 * 1024),
      'content-type': 'application/octet-stream', 'x-forwarded-for': m.address,
    },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' }).catch((error: unknown) => new Response(String(error), { status: 599 }))
  return { answer, release: () => close() }
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** Read a body to its end; `cut` — it ended with an error (the server let it go). */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<{ bytes: number; cut: boolean }> {
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return { bytes, cut: false }
      bytes += value.length
    }
  } catch {
    return { bytes, cut: true }
  }
}

/* --------------------------------------------------------- #0 the codes */

test('the owner cancels a code, and «Отключить все» ends every code still valid: no fresh machine joins through a door left open', async () => {
  reset()
  const minted = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 3, hours: 12, trusted: true, approvedSlots: null, namePrefix: 'exam' } })
  assert.equal(minted.status, 200)
  assert.match(minted.body.id, /^[a-f0-9]{16}$/, 'an id that names one code')
  // The list carries what a row with «Отменить» needs.
  const listed = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body.codes.find((one) => one.id === minted.body.id)
  assert.ok(listed, 'the code is listed while it is valid')
  assert.deepEqual([listed.machines, listed.used, listed.trusted, listed.namePrefix, listed.createdBy, listed.console], [3, 0, true, 'exam', owner.name, false])
  const first = new Machine(await serve())
  assert.equal((await first.join(minted.body.code)).status, 200)
  // The owner's door, the owner's only.
  assert.equal((await admin('DELETE', `/api/admin/runners/codes/${minted.body.id}`, { cookie: teacher.cookie })).status, 403)
  const ended = await admin<RemoteMachinesResponse>('DELETE', `/api/admin/runners/codes/${minted.body.id}`)
  assert.equal(ended.status, 200)
  assert.equal(ended.body.codes.some((one) => one.id === minted.body.id), false, 'gone from the list')
  assert.equal((await new Machine(await serve()).join(minted.body.code)).status, 403, 'and nothing joins with it any more')
  assert.equal(getRunner(first.runnerId)?.state, 'active', 'the machine it enrolled stays')
  assert.equal((await admin('DELETE', `/api/admin/runners/codes/${minted.body.id}`)).status, 404, 'a code ended is no code to end')
  // Minting and ending are the owner's acts in the audit log, with how wide the door was.
  const events = listAdminEvents({ limit: 50 }).events
  const mintedLine = events.find((event) => event.action === 'runner.code_minted' && event.target?.id === minted.body.id)
  assert.ok(mintedLine, 'the mint is audited')
  assert.deepEqual([mintedLine.detail?.machines, mintedLine.detail?.hours, mintedLine.detail?.trusted, mintedLine.actor?.name], [3, 12, true, owner.name])
  assert.ok(events.some((event) => event.action === 'runner.code_ended' && event.target?.id === minted.body.id), 'the cancel is audited')

  // «Отключить все»: every machine, and every code still valid with them.
  const second = await admin<MintRemoteCodeResponse>('POST', '/api/admin/runners/codes', { body: { machines: 2, hours: 1, trusted: false, approvedSlots: null } })
  assert.equal((await admin('POST', '/api/admin/runners/revoke-all', { body: {} })).status, 200)
  assert.equal(getRunner(first.runnerId)?.state, 'revoked')
  assert.equal((await new Machine(await serve()).join(second.body.code)).status, 403, 'after «Отключить все» a machine comes back only with a new code')
  assert.ok(listAdminEvents({ limit: 50 }).events.some((event) => event.action === 'runner.code_ended' && event.target?.id === second.body.id && event.detail?.all === true))
})

test('an id two live codes share names neither: the cancel is refused rather than guessing', () => {
  const now = Date.now()
  const prefix = 'f'.repeat(16)
  for (const tail of ['a', 'b']) {
    db.prepare(`INSERT INTO remote_runner_codes (code_sha256, created_by, created_at, expires_at, uses_left, trusted, approved_slots, name_prefix, machines)
      VALUES (?, 'tests', ?, ?, 1, 0, NULL, '', 1)`).run(`${prefix}${tail.repeat(48)}`, now, now + 60_000)
  }
  assert.deepEqual(endRemoteCode(prefix, now), { refused: 'ambiguous' })
  assert.deepEqual(endRemoteCode('0'.repeat(16), now), { refused: 'unknown' })
  assert.deepEqual(endRemoteCode('not-an-id', now), { refused: 'unknown' })
  db.prepare('DELETE FROM remote_runner_codes WHERE code_sha256 LIKE ?').run(`${prefix}%`)
})

/* ------------------------------------------- #1, #2, #20, #21, #22 blobs */

test('an untrust cuts the hidden test already on its way to the machine, and a revoke cuts every stream', async () => {
  reset()
  resetBlobBucket()
  saveCompetitionSettings({ runnerBlobMBps: 1 })
  try {
    const c = competition({ sealed: true })
    const big = Buffer.alloc(3 * 1024 * 1024, 3)
    const stored = putSealedFile(c.id, 'hidden.bin', big)
    putFile({ competitionId: c.id, name: 'hidden.bin', bytes: stored.bytes, visibility: 'sealed', sha256: stored.sha256 })
    forgetStock()
    send(c)
    const m = await joined({ trusted: true })
    await m.sync()
    const answer = await m.call('GET', `blobs/${stored.sha256}`)
    assert.equal(answer.status, 200)
    const reader = answer.body!.getReader()
    const first = await reader.read()
    untrustRunner(m.runnerId)
    const rest = await drain(reader)
    assert.ok(rest.cut || first.value!.length + rest.bytes < big.length, `the rest of the hidden file did not reach the machine: ${rest.bytes} bytes after the untrust`)
    assert.equal(openBlobStreams(m.runnerId), 0)

    // A revoke: an open data stream, cut as well.
    const open = putOpenFile(c.id, 'open.bin', big)
    putFile({ competitionId: c.id, name: 'open.bin', bytes: open.bytes, visibility: 'open', sha256: open.sha256 })
    forgetStock()
    const other = await joined()
    await other.sync()
    const flowing = await other.call('GET', `blobs/${open.sha256}`)
    assert.equal(flowing.status, 200)
    const otherReader = flowing.body!.getReader()
    await otherReader.read()
    revokeRunner(other.runnerId)
    const after = await drain(otherReader)
    assert.ok(after.cut || after.bytes < big.length - 64 * 1024, 'the revoked machine is sent nothing more')
    assert.equal(openBlobStreams(other.runnerId), 0, 'and holds no stream of the server\'s three')
  } finally {
    saveCompetitionSettings({ runnerBlobMBps: null })
    resetBlobBucket()
  }
})

test('every fetch of the hidden test is in the machine\'s log with the address it came from', async () => {
  reset()
  resetBlobBucket()
  const c = competition({ sealed: true })
  send(c)
  const home = await serve()
  const m = await joined({ trusted: true })
  m.address = '198.51.100.10'
  const hidden = (await m.sync()).body.want.data.find((entry) => entry.competitionId === c.id && entry.sealed)!.files[0]
  await (await m.call('GET', `blobs/${hidden.sha256}`)).arrayBuffer()
  // The same credential from somewhere else: a stolen secret leaves its address.
  const thief = Object.assign(new Machine(home), { runnerId: m.runnerId, secret: m.secret, address: '203.0.113.66' })
  const stolen = await thief.call('GET', `blobs/${hidden.sha256}`)
  assert.equal(stolen.status, 200)
  await stolen.arrayBuffer()
  const lines = runnerEvents(m.runnerId).filter((event) => event.kind === 'sealed_fetched')
  assert.deepEqual(lines.map((line) => line.address).sort(), ['198.51.100.10', '203.0.113.66'])
  // A resume from the same address within minutes is the same fetch, not a line a second.
  await (await m.call('GET', `blobs/${hidden.sha256}`, { headers: { range: 'bytes=1-' } })).arrayBuffer()
  assert.equal(runnerEvents(m.runnerId).filter((event) => event.kind === 'sealed_fetched').length, 2)
})

test('after this server restarts, a machine is served what it was asked to hold before its first sync of the new life is answered', async () => {
  reset()
  resetBlobBucket()
  const c = competition({ sealed: true })
  send(c)
  const m = await joined()
  const want = (await m.sync()).body.want
  const train = want.data.find((entry) => entry.competitionId === c.id && !entry.sealed)!.files.find((file) => file.name === 'train.csv')!
  // A new life: nothing in memory of what the last reply said.
  forgetWantScope(m.runnerId)
  resetHeard(Date.now() - 10 * 60_000)
  const resumed = await m.call('GET', `blobs/${train.sha256}`, { headers: { range: 'bytes=1-' } })
  assert.equal(resumed.status, 206, 'the download it resumes first is served')
  await resumed.arrayBuffer()
  // And the scope is still the machine's: no hidden test to an untrusted one.
  const sealed = dataNow(c.id).sealed!.files[0]
  forgetWantScope(m.runnerId)
  assert.equal((await m.call('GET', `blobs/${sealed.sha256}`)).status, 404)
})

test('a stream nothing is taken off is cut within the stall limit, and its place freed', async () => {
  reset()
  resetBlobBucket()
  saveCompetitionSettings({ runnerBlobMBps: 1 })
  useBlobStallMs(400)
  try {
    const c = competition()
    const big = Buffer.alloc(4 * 1024 * 1024, 9)
    const stored = putOpenFile(c.id, 'stall.bin', big)
    putFile({ competitionId: c.id, name: 'stall.bin', bytes: stored.bytes, visibility: 'open', sha256: stored.sha256 })
    forgetStock()
    send(c)
    const m = await joined()
    await m.sync()
    const answer = await m.call('GET', `blobs/${stored.sha256}`)
    assert.equal(answer.status, 200)
    // The machine vanished: nothing is read.
    assert.equal(openBlobStreams(m.runnerId), 1)
    await until('the stalled stream to be let go', () => openBlobStreams(m.runnerId) === 0, 5_000)
    await answer.body?.cancel().catch(() => undefined)
  } finally {
    saveCompetitionSettings({ runnerBlobMBps: null })
    resetBlobBucket()
  }
})

/* ---------------------------------------------------- #4, #6, #8, #9 uploads */

test('an attempt stages one file per name: a new hash replaces the old one, never lands beside it', async () => {
  reset()
  const c = competition()
  send(c)
  const m = await joined()
  const { lease } = await leaseOn(m, c)
  const staged = () => fs.readdirSync(stagingDir(lease.attemptId)).filter((name) => !name.endsWith('.part'))
  for (let i = 0; i < 4; i++) {
    const body = Buffer.alloc(1024 * 1024)
    body[0] = i + 1
    assert.equal((await m.put(lease.attemptId, 'executed.ipynb', body)).status, 200, `PUT ${i + 1}`)
  }
  assert.equal(staged().filter((name) => name.startsWith('executed.ipynb.')).length, 1, 'one notebook staged, the last one')
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  assert.equal(staged().length, 2)
  // The last of each is the attempt's: its outcome applies.
  const last = Buffer.alloc(1024 * 1024)
  last[0] = 4
  const out = await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }, { name: 'executed.ipynb', body: last.toString('latin1') }]))
  void out
})

test('an attempt\'s room is its two caps: a part past them is refused before its body is read', async () => {
  reset()
  const c = competition()
  send(c)
  const m = await joined()
  const { lease } = await leaseOn(m, c)
  // Two notebooks staged under one attempt by hand (a staging folder older than the rule), each at the cap.
  const dir = stagingDir(lease.attemptId)
  fs.mkdirSync(dir, { recursive: true })
  for (const fill of ['a', 'b']) {
    const file = path.join(dir, `executed.ipynb.${fill.repeat(64)}`)
    fs.writeFileSync(file, '')
    fs.truncateSync(file, 64 * 1024 * 1024)
  }
  const refused = await m.put(lease.attemptId, 'submission.csv', ANSWER)
  assert.equal(refused.status, 413)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('one machine holds at most its share of the upload slots, and a body that sends nothing is let go', async () => {
  reset()
  useUploadStallMs(60_000)
  const home = await serve()
  const c = competition()
  send(c)
  send(c)
  const greedy = await joined()
  const { lease } = await leaseOn(greedy, c)
  const honest = await joined()
  const other = await leaseOn(honest, c)
  const held = [stalledPut(home, greedy, lease.attemptId), stalledPut(home, greedy, lease.attemptId)]
  try {
    await until('both of the machine\'s uploads to be under way', () => activeUploads(greedy.runnerId) === 2)
    const third = await greedy.put(lease.attemptId, 'submission.csv', ANSWER)
    assert.equal(third.status, 503, 'a third of the same machine waits: half the slots are its share')
    assert.equal((await honest.put(other.lease.attemptId, 'submission.csv', ANSWER)).status, 200, 'another machine\'s result goes in')
  } finally {
    for (const one of held) one.release()
    await Promise.all(held.map((one) => one.answer))
  }
  // A body that sends nothing is ended, and its slot freed, without waiting for Node's request timeout.
  useUploadStallMs(300)
  const stalled = stalledPut(home, greedy, lease.attemptId)
  try {
    await until('the stalled upload to start', () => activeUploads(greedy.runnerId) === 1)
    await until('the stalled upload to be let go', () => activeUploads(greedy.runnerId) === 0, 5_000)
  } finally {
    stalled.release()
    await stalled.answer
    useUploadStallMs(null)
  }
})

test('a refused upload\'s write still queued never lands in the next upload\'s file', async () => {
  reset()
  const c = competition()
  send(c, { at: Date.now() - 2 })
  send(c, { at: Date.now() - 1 })
  const m = await joined()
  const ready = await readyFor(m, [c])
  const leases = (await m.sync({ ready, free: FREE(2) })).body.leases
  assert.equal(leases.length, 2)
  await m.sync({ seq: Math.max(...leases.map((one) => one.seq)), ready, free: FREE(0), attempts: leases.map((one) => ({ id: one.attemptId, phase: 'running' as const, runningMs: 0 })) })
  const [bombed, victim] = leases
  // A write queued in a busy thread pool: it runs after the moment pipeline() gives up on the stream.
  const write = fs.write
  ;(fs as { write: unknown }).write = ((...args: unknown[]) => {
    setTimeout(() => (write as (...a: unknown[]) => void)(...args), 40)
  }) as typeof fs.write
  try {
    const bomb = zlib.gzipSync(Buffer.alloc(32 * 1024 * 1024))
    const refused = await m.put(bombed.attemptId, 'executed.ipynb', Buffer.alloc(0), { sha256: 'a'.repeat(64), bytes: String(1024 * 1024), raw: bomb })
    assert.equal(refused.status, 413)
    assert.equal((await m.put(victim.attemptId, 'submission.csv', ANSWER)).status, 200)
  } finally {
    ;(fs as { write: unknown }).write = write
  }
  const staged = fs.readdirSync(stagingDir(victim.attemptId)).filter((name) => name.startsWith('submission.csv.') && !name.endsWith('.part'))
  assert.equal(staged.length, 1)
  assert.equal(fs.statSync(path.join(stagingDir(victim.attemptId), staged[0])).size, Buffer.byteLength(ANSWER), 'the honest answer, and nothing of the bomb')
  const out = await m.outcome(victim.attemptId, finished(victim.attemptId, [{ name: 'submission.csv', body: ANSWER }]))
  assert.equal((out.body as RemoteOutcomeReply).result, 'applied')
})

/* ---------------------------------------------------------- #5 the log */

test('a machine\'s log names only the readiness this server asked for, and only so many lines an hour', async () => {
  reset()
  const c = competition()
  const m = await joined()
  const hex = (text: string, chars: number) => Buffer.from(text).toString('hex').padEnd(chars, '0').slice(0, chars)
  const madeUp = (set: string) => ({
    revisions: Array.from({ length: 32 }, (_, i) => hex(`${set}r${i}`, 32)),
    data: Array.from({ length: 64 }, (_, i) => hex(`${set}d${i}`, 64)),
    sealed: Array.from({ length: 64 }, (_, i) => hex(`${set}s${i}`, 64)),
    bundles: [],
  })
  assert.equal((await m.sync({ ready: madeUp('A') })).status, 200)
  const count = (kind: string) => runnerEvents(m.runnerId, 10_000).filter((event) => event.kind === kind).length
  for (let i = 0; i < 6; i++) assert.equal((await m.sync({ ready: madeUp(i % 2 ? 'A' : 'B') })).status, 200)
  assert.equal(count('image_ready') + count('data_ready'), 0, 'ids home never asked for write nothing')
  // What it was asked for is written, with the address.
  const ready = await readyFor(m, [c])
  await m.sync({ ready })
  assert.equal(count('image_ready'), 1)
  assert.equal(count('data_ready'), 1)
  // A problem about a thing home never asked for writes nothing; the machine's own, and one about what it was asked for, are written.
  await m.sync({ ready, problems: [{ code: 'image', revisionId: hex('made-up', 32), detail: 'pull failed' }] })
  assert.equal(count('problem'), 0)
  await m.sync({ ready, problems: [{ code: 'disk', detail: 'below its floor' }, { code: 'image', revisionId: c.revisionId, detail: 'pull failed' }] })
  assert.equal(count('problem'), 2)
  // A build flipping between two strings home never had writes «outdated» once, when it stopped being home's.
  for (let i = 0; i < 6; i++) await m.sync({ build: (i % 2 ? 'a' : 'b').repeat(64) })
  assert.equal(count('outdated'), 1)
})

/* ----------------------------------------------------- #11 the stopwatch */

test('a machine\'s preparation is neither the participant\'s clock nor the run\'s time in the teacher\'s history', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = await joined()
  const ready = await readyFor(m, [c])
  const lease = (await m.sync({ ready, free: FREE(1) })).body.leases[0]
  assert.ok(lease)
  // Two minutes of pulls and wheels: the take was two minutes ago.
  const twoMinutes = 120_000
  db.prepare('UPDATE remote_leases SET offered_at = offered_at - ? WHERE attempt_id = ?').run(twoMinutes, lease.attemptId)
  db.prepare('UPDATE submission_runs SET started_at = started_at - ? WHERE attempt_id = ?').run(twoMinutes, lease.attemptId)
  await m.sync({ seq: lease.seq, ready, free: FREE(0), attempts: [{ id: lease.attemptId, phase: 'preparing' }] })
  assert.equal(queueRow(sent.id)?.startedAt, null, 'no clock while the machine prepares')
  const preparing = queueForecast(1).running.find((row) => row.submissionId === sent.id)
  assert.equal(preparing?.startedAt, null)
  const console1 = (await admin<QueueSnapshot>('GET', '/api/admin/competitions/queue')).body.running.find((run) => run.submissionId === sent.id)!
  assert.ok(Date.now() - console1.startedAt < 5_000, 'the console\'s clock has not started either')
  const before = Date.now()
  await m.sync({ seq: lease.seq, ready, free: FREE(0), attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 1000 }] })
  const started = queueRow(sent.id)!.startedAt!
  assert.ok(started >= before - 1_500 && started <= Date.now(), 'the clock starts with the container')
  const run = listRuns(sent.id).find((one) => one.kind === 'notebook')!
  assert.equal(run.startedAt, getLease(lease.attemptId)!.startedAt, 'and the run row starts with it too')
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  const out = await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }], { wall: 4200 }))
  assert.equal((out.body as RemoteOutcomeReply).result, 'applied')
  const settled = listRuns(sent.id).find((one) => one.kind === 'notebook')!
  assert.equal(settled.finishedAt! - settled.startedAt, 4200, 'the history reads the run\'s own time')
})

/* ----------------------------------------------- #12, #13, #14 liveness */

test('when the path comes back after an outage, every machine gets a whole silence from that moment before anything is lost', () => {
  reset()
  const t0 = Date.now()
  resetHeard(t0 - 30 * 60_000)
  const c = competition()
  send(c, { at: t0 - 2 })
  send(c, { at: t0 - 1 })
  const a = machineRow()
  const b = machineRow()
  const leaseA = takeForRunner(a, offerFor(a, c, { free: FREE(1) }), t0)[0]!
  const leaseB = takeForRunner(b, offerFor(b, c, { free: FREE(1) }), t0)[0]!
  for (const lease of [leaseA, leaseB]) updateLease(lease.attemptId, { state: 'running', acceptedAt: t0, startedAt: t0, phase: 'running' })
  noteCall(a.id, t0, null)
  noteCall(b.id, t0, null)
  // Ten minutes of a dead relay: nothing heard, no probe passes, nothing expires.
  for (let at = t0 + 5_000; at <= t0 + 10 * 60_000; at += 5_000) assert.equal(remoteTick(at).lost, 0, `nothing lost at +${(at - t0) / 1000} s`)
  // The relay is back: A comes first, B is still in its backoff.
  const back = t0 + 10 * 60_000 + 3_000
  noteCall(a.id, back, null)
  assert.equal(remoteTick(back + 2_000).lost, 0)
  assert.equal(getLease(leaseB.attemptId)?.state, 'running', 'B is not lost for the outage the path was blind through')
  // A whole silence after the path came back, with A heard all along: now B is gone.
  noteCall(a.id, back + REMOTE_SILENCE_MS + 10_000, null)
  remoteTick(back + REMOTE_SILENCE_MS + 10_000)
  assert.equal(getLease(leaseB.attemptId)?.state, 'lost')
  assert.equal(getLease(leaseA.attemptId)?.state, 'running')
  reset()
})

test('a probe passing after an outage is no proof of a lone machine\'s whole silence either', () => {
  reset()
  const t0 = Date.now()
  resetHeard(t0 - 30 * 60_000)
  const c = competition()
  send(c)
  const m = machineRow()
  const lease = takeForRunner(m, offerFor(m, c, { free: FREE(1) }), t0)[0]!
  updateLease(lease.attemptId, { state: 'running', acceptedAt: t0, startedAt: t0, phase: 'running' })
  noteCall(m.id, t0, null)
  for (let at = t0 + 5_000; at <= t0 + 10 * 60_000; at += 5_000) remoteTick(at)
  noteProbe(true, t0 + 10 * 60_000)
  remoteTick(t0 + 10 * 60_000 + 5_000)
  assert.equal(getLease(lease.attemptId)?.state, 'running')
  reset()
})

test('after a rollback and forward again, the leases whose rows the old release ran are ended at boot with no penalty, and the machine is told', async () => {
  reset()
  const c = competition()
  const subs = [send(c, { at: Date.now() - 3 }), send(c, { at: Date.now() - 2 }), send(c, { at: Date.now() - 1 })]
  const m = await joined()
  const ready = await readyFor(m, [c])
  const leases = (await m.sync({ ready, free: FREE(3) })).body.leases
  assert.equal(leases.length, 3)
  const seq = Math.max(...leases.map((one) => one.seq))
  await m.sync({ seq, ready, free: FREE(0), attempts: leases.map((one) => ({ id: one.attemptId, phase: 'running' as const, runningMs: 1000 })) })
  // What 0.22 leaves: each row taken back as its own orphan and run again under an attempt of its own, the holder kept.
  for (const sub of subs) {
    db.prepare("UPDATE competition_queue SET state = 'running', started_at = ?, boot = 'boot-of-0.22', attempt_id = ?, container = NULL WHERE submission_id = ?")
      .run(Date.now(), randomUUID().replaceAll('-', ''), sub.id)
  }
  // Forward again: the reclaim gives the rows back, and the machines' boot ends the leases left without them.
  reclaimQueue(BOOT, Date.now())
  const boot = await bootRemoteRunners(Date.now())
  assert.equal(boot.strays, 3)
  for (const lease of leases) assert.deepEqual([getLease(lease.attemptId)?.state, getLease(lease.attemptId)?.cause], ['revoked', 'orphan'])
  const told = await m.sync({ seq, ready, free: FREE(0), attempts: leases.map((one) => ({ id: one.attemptId, phase: 'running' as const, runningMs: 2000 })) })
  assert.deepEqual(told.body.revoke.map((one) => one.reason), ['cancelled', 'cancelled', 'cancelled'], 'the machine drops the runs')
  assert.equal(getRunner(m.runnerId)?.state, 'active', 'and no quarantine for this server\'s rollback')
  for (const sub of subs) {
    assert.equal(queueRow(sub.id)?.lost ?? 0, 0)
    assert.ok(listRuns(sub.id).every((run) => run.finishedAt !== null), 'no run row is left open')
  }
})

test('a lease whose row it no longer owns is ended the moment the machine reports it, not lost later', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = await joined()
  const { lease, ready } = await leaseOn(m, c)
  db.prepare("UPDATE competition_queue SET attempt_id = ? WHERE submission_id = ?").run(randomUUID().replaceAll('-', ''), sent.id)
  const told = await m.sync({ seq: lease.seq, ready, free: FREE(0), attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 500 }] })
  assert.deepEqual(told.body.revoke, [{ id: lease.attemptId, reason: 'cancelled' }])
  assert.deepEqual([getLease(lease.attemptId)?.state, getLease(lease.attemptId)?.cause], ['revoked', 'orphan'])
})

test('resuming a quarantined machine starts its quarantine window over: one more loss does not drain it again', async () => {
  reset()
  const c = competition()
  const m = await joined()
  const now = Date.now()
  for (let i = 0; i < 3; i++) {
    send(c, { at: now + i })
    const lease = takeForRunner(getRunner(m.runnerId)!, offerFor(getRunner(m.runnerId)!, c, { free: FREE(1) }), now + i)[0]!
    updateLease(lease.attemptId, { state: 'running', acceptedAt: now + i, startedAt: now + i, phase: 'running' })
    loseLease(lease.attemptId, now + i + 1, 'missing')
  }
  assert.equal(getRunner(m.runnerId)?.state, 'draining')
  assert.equal((await admin('POST', `/api/admin/runners/${m.runnerId}/resume`, { body: {} })).status, 200)
  assert.equal(getRunner(m.runnerId)?.state, 'active')
  send(c, { at: now + 10 })
  const later = Date.now() + 60_000
  const lease = takeForRunner(getRunner(m.runnerId)!, offerFor(getRunner(m.runnerId)!, c, { free: FREE(1) }), later)[0]!
  updateLease(lease.attemptId, { state: 'running', acceptedAt: later, startedAt: later, phase: 'running' })
  loseLease(lease.attemptId, later + 1, 'missing')
  assert.equal(getRunner(m.runnerId)?.state, 'active', 'one loss after the owner\'s decision is one loss')
})

/* --------------------------------------------------- #15 the decline skip */

test('a row every live machine skips for a decline gets no place, and the participant reads «готовится»', () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = machineRow()
  const now = Date.now()
  noteSync(m.id, syncRequest({ ready: { revisions: [c.revisionId], data: [dataNow(c.id).open!.manifest], sealed: [], bundles: [] } }), now, null)
  const lease = takeForRunner(m, offerFor(m, c), now)[0]!
  assert.equal(declineLease(lease.attemptId, now, 'disk', 'full'), 'declined')
  const reasons = waitReasons(queueRows(), { homeCards: false, now })
  const reason = reasons.get(sent.id)
  assert.equal(reason?.reason, 'returned')
  assert.equal(reason?.skipped, true)
  assert.equal(blocking(reason), true, 'no place')
  assert.equal(queueForecast(1, now).at.get(sent.id), undefined, 'and no ETA from a machine that will not take it')
  // Once the skip is over, its place and ETA come back.
  const later = now + REMOTE_DECLINE_SKIP_MS + 1_000
  noteSync(m.id, syncRequest({ ready: { revisions: [c.revisionId], data: [dataNow(c.id).open!.manifest], sealed: [], bundles: [] } }), later, null)
  assert.equal(blocking(waitReasons(queueRows(), { homeCards: false, now: later }).get(sent.id)), false)
  reset()
})

/* ------------------------------------------------------- #16 the probe */

test('the self-probe is evidence only when the address leaves this host', async () => {
  const own = () => new Set(['10.1.2.3', '172.17.0.2'])
  assert.equal(await leavesHost('http://lab-gpu:3000', async () => ['127.0.1.1'], own), false, 'a hostname /etc/hosts maps to loopback')
  assert.equal(await leavesHost('http://10.1.2.3:3000', async () => [], own), false, 'this host\'s own LAN address')
  assert.equal(await leavesHost('https://home.example', async () => ['10.1.2.3'], own), false, 'a name that resolves here')
  assert.equal(await leavesHost('https://home.example', async () => ['169.254.10.1'], own), false, 'link-local')
  assert.equal(await leavesHost('https://vsos.colloq.ru', async () => ['203.0.113.10'], own), true, 'an address elsewhere')
  assert.equal(await leavesHost('https://nowhere.invalid', async () => [], own), false, 'a name that does not resolve')
  assert.ok(os.networkInterfaces())
  // A probe that would come straight back here is never made, and passes for nothing.
  reset()
  machineRow()
  let fetched = 0
  const passing = (async () => {
    fetched++
    return new Response('ok', { status: 200 })
  }) as typeof fetch
  assert.equal(await probeOwnPath(Date.now(), passing, 'http://lab-gpu:3000', async () => false), false)
  assert.equal(fetched, 0)
  assert.equal(await probeOwnPath(Date.now(), passing, 'https://vsos.colloq.ru', async () => true), true)
})

/* ----------------------------------------- #17 a lease's own blobs, starved */

test('a decline for data this server\'s own streams caused counts against no machine', () => {
  reset()
  const c = competition()
  const m = machineRow()
  const now = Date.now()
  // Five such declines would quarantine a machine refusing on its own; these are this server's (blobs.ts · starvedLease).
  const sent = send(c, { at: now })
  for (let i = 0; i < 6; i++) {
    // The same submission each time: a starved decline is not skipped, so the machine takes it straight back.
    const lease = takeForRunner(getRunner(m.id)!, offerFor(getRunner(m.id)!, c, { free: FREE(1) }), now + i)[0]!
    assert.equal(lease.submissionId, sent.id)
    // The route's own mark: a 429 for the lease's own blob with every stream a lease's (over HTTP in remote-runners-doors).
    markStarved(lease.attemptId)
    assert.equal(starvedLease(lease.attemptId), true)
    assert.equal(declineLease(lease.attemptId, now + i, 'data', 'the notebook could not be had: the lease stopped waiting'), 'declined')
    assert.equal(getLease(lease.attemptId)?.cause, 'starved')
  }
  assert.equal(getRunner(m.id)?.state, 'active', 'no quarantine')
  assert.equal(getSubmission(sent.id)?.state, 'queued', 'no submission given up on for this server\'s wait')
  reset()
})

/* ------------------------------------------ #31, #61 places in real runs */

test('a machine\'s places are counted in the competition\'s own runs: the forecast, the console and the list promise what the take leases', async () => {
  reset()
  const c = competition({ memoryMb: 8192, cpus: 1 })
  for (let i = 0; i < 10; i++) send(c, { at: Date.now() - 100 + i })
  const m = await joined()
  const ready = await readyFor(m, [c])
  // An idle 16-vCPU / 32 GB machine: fifteen of the smallest runs, three of this competition's.
  const idle = { slots: 15, memoryMb: 30_720, cpus: 15, gpuShares: 0, diskMb: 150_000 }
  const leased = (await m.sync({ ready, free: idle })).body.leases
  assert.equal(leased.length, 3, 'the take leases three')
  const busy = { slots: 12, memoryMb: 5_376, cpus: 12, gpuShares: 0, diskMb: 149_000 }
  await m.sync({ seq: Math.max(...leased.map((one) => one.seq)), ready, free: busy, attempts: leased.map((one) => ({ id: one.attemptId, phase: 'running' as const, runningMs: 0 })) })
  assert.equal(remoteFleet(Date.now(), placeMix()).places, 3, 'the forecast\'s places')
  const forecast = queueForecast(1)
  const startingNow = forecast.eligible.filter((row) => row.competitionId === c.id && forecast.at.get(row.submissionId)?.startMs === 0)
  assert.equal(startingNow.length, 0, 'nothing waiting is promised a start now: the machine is full')
  const live = (await admin<CompetitionLive>('GET', `/api/admin/competitions/${c.id}/live`)).body
  const group = live.queue.groups?.find((one) => one.machineId === m.runnerId)
  assert.deepEqual([group?.places, group?.busy], [3, 3], 'the console\'s group')
  const list = (await admin<RemoteMachinesResponse>('GET', '/api/admin/runners')).body
  assert.equal(list.machines.find((one) => one.id === m.runnerId)?.places.offered, 3, 'the machine\'s row')
  assert.equal(list.summary.places, 3, 'the block\'s summary')
  const where = (await admin<CompetitionView>('GET', `/api/admin/competitions/${c.id}`)).body.where!
  const machine = where.machines.find((one) => one.id === m.runnerId)!
  assert.deepEqual([machine.places, machine.state], [3, 'online'], '«Где считается», with the machine\'s state')
})

/* ------------------------------------------------------ #33 unfit GPU work */

test('a GPU notebook whose set no longer fits, on a server with notebooks on and no card, is settled here instead of waiting for ever', async () => {
  reset({ homeNotebooks: true })
  const MiB = 1024 * 1024
  const c = competition({ gpu: true, memoryMb: 2048 })
  setPolicy(c.id, { enabled: true })
  const sent = send(c, { revisionId: null })
  const set = createBundle(c.id, sent.entrantId, c.revisionId, 'catboost')
  completeBundle(set.id, {
    normalizedRequirements: ['catboost'], downloadBytes: 1, installedBytes: 315 * MiB, contentHash: '5'.repeat(64),
    packages: [{ name: 'catboost', version: '1.2.10', fileName: 'catboost-1.2.10-py3-none-any.whl', sha256: '6'.repeat(64), bytes: 1 }],
    lock: `catboost==1.2.10 --hash=sha256:${'6'.repeat(64)}\n`,
  })
  bindSubmission(sent.id, c.revisionId, set.id)
  updateCompetition(c.id, { limits: { ...c.limits, memoryMb: 512 } })
  machineRow()
  const reason = waitReasons(queueRows(), { homeCards: false }).get(sent.id)
  assert.equal(reason?.reason, 'no_fit', 'it has a reason')
  assert.equal(blocking(reason), true, 'and no place')
  assert.equal(settleUnfit(), 1)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(getSubmission(sent.id)?.state, 'rejected')
  assert.equal(queueRow(sent.id), null)
  reset()
})

/* ----------------------------------------------------- #40 the budget */

test('with «Тетради на этом сервере» off, the Resources bar counts the metric lane, not notebooks that never run here', async () => {
  reset({ homeNotebooks: false })
  const off = (await admin<ResourceSettingsResponse>('GET', '/api/admin/resources')).body.budget.competitions
  const slots = scoreSlotsSetting().value
  const { limits } = competitionDefaults()
  assert.equal(off.slots, slots)
  assert.equal(off.memoryMb, slots * (256 + Math.min(2048, Math.max(512, limits.memoryMb))))
  saveCompetitionSettings({ homeNotebooks: true })
  const on = (await admin<ResourceSettingsResponse>('GET', '/api/admin/resources')).body.budget.competitions
  assert.equal(on.memoryMb, (on.slots ?? 0) * limits.memoryMb)
  reset()
})

/* ------------------------------------------- #41 the clock during a metric */

test('while a machine\'s result is scored here, the participant reads «оценивается» and the clock goes on from the notebook\'s time', async () => {
  reset()
  const c = competition()
  const sent = send(c)
  const m = await joined()
  const { lease } = await leaseOn(m, c)
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  const out = await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }], { wall: 90_000 }))
  assert.equal((out.body as RemoteOutcomeReply).result, 'applied')
  // The metric lane takes the row: running here, from now.
  const metricStart = Date.now()
  db.prepare("UPDATE competition_queue SET state = 'running', started_at = ?, boot = ?, attempt_id = ? WHERE submission_id = ? AND kind = 'metric'")
    .run(metricStart, BOOT, randomUUID().replaceAll('-', ''), sent.id)
  const home = await serve()
  const signIn = await fetch(`${home}/api/k/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: entrantKeyOf(sent.entrantId) }) })
  const cookie = signIn.headers.getSetCookie().find((line) => line.startsWith(`${ENTRANT_COOKIE}=`))!.split(';')[0]
  const mine = (await (await fetch(`${home}/api/k/competitions/${c.slug}/submissions`, { headers: { cookie } })).json()) as EntrantSubmissions
  const live = mine.live.find((one) => one.submissionId === sent.id)!
  assert.equal(live.scoring, true, '«оценивается»')
  assert.equal(live.startedAt, metricStart - getSubmission(sent.id)!.durationMs!, 'the clock reads the notebook\'s time, never 0:01')
  assert.equal(getSubmission(sent.id)!.durationMs, 90_000)
})

/* -------------------------------------------- #44 «Работают сейчас» */

test('«Работают сейчас» counts the metrics of machines\' results, not rescores', () => {
  reset()
  const c = competition()
  const held = send(c)
  const m = machineRow()
  takeForRunner(m, offerFor(m, c, { free: FREE(1) }), Date.now())
  assert.equal(queueRow(held.id)?.holder, m.id)
  const fresh = send(c)
  const rescore = send(c)
  for (const [sub, isFresh] of [[fresh, 1], [rescore, 0]] as const) {
    db.prepare("UPDATE competition_queue SET kind = 'metric', state = 'running', started_at = ?, boot = ?, attempt_id = ?, holder = NULL, fresh = ? WHERE submission_id = ?")
      .run(Date.now(), BOOT, randomUUID().replaceAll('-', ''), isFresh, sub.id)
  }
  const ownerRow = { id: 'owner', role: 'owner' } as unknown as Parameters<typeof runningRemote>[0]
  const entry = runningRemote(ownerRow)?.find((one) => one.competitionId === c.id)
  assert.equal(entry?.scoring, 1)
  reset()
})

/* --------------------------------------- #54, #55, #62 what a pass reads */

test('a forecast reads an environment\'s files once per revision, not once per waiting row', () => {
  reset()
  const c = competition()
  for (let i = 0; i < 40; i++) send(c, { at: Date.now() - 1000 + i })
  machineRow()
  const read = fs.readFileSync
  let lists = 0
  ;(fs as { readFileSync: unknown }).readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof file === 'string' && file.endsWith('.txt')) lists++
    return (read as (...a: unknown[]) => unknown)(file, ...rest)
  }) as typeof fs.readFileSync
  try {
    forgetStock()
    queueForecast(1)
    queueForecast(1)
  } finally {
    ;(fs as { readFileSync: unknown }).readFileSync = read
  }
  assert.ok(lists <= 8, `${lists} reads of environment lists for two forecasts of 40 rows`)
  reset()
})

test('a lease keeps of the competition only what its settle reads: no metric code, no description in every lease row', async () => {
  reset()
  const c = competition()
  db.prepare('UPDATE competitions SET description = ?, metric_code = ? WHERE id = ?').run('Д'.repeat(20_000), `# ${'x'.repeat(30_000)}\ndef score(solution, submission):\n    return 1.0\n`, c.id)
  send(c)
  const m = await joined()
  const { lease } = await leaseOn(m, c)
  const prepared = JSON.parse((db.prepare('SELECT prepared FROM remote_leases WHERE attempt_id = ?').get(lease.attemptId) as { prepared: string }).prepared) as { competition: Record<string, unknown> }
  assert.deepEqual(Object.keys(prepared.competition).sort(), ['baselineEntrantId', 'baselineSubmissionId', 'id', 'limits'])
  assert.ok(JSON.stringify(prepared).length < 4_000)
  // And the outcome is still settled, against the limits as the take read them.
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  assert.equal(((await m.outcome(lease.attemptId, finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]))).body as RemoteOutcomeReply).result, 'applied')
})

test('a reply names the package sets of the stock without reading each set\'s whole row again', async () => {
  reset()
  const MiB = 1024 * 1024
  const c = competition()
  setPolicy(c.id, { enabled: true })
  for (let i = 0; i < 5; i++) {
    const sent = send(c, { revisionId: null })
    const set = createBundle(c.id, sent.entrantId, c.revisionId, `pkg${i}`)
    completeBundle(set.id, {
      normalizedRequirements: [`pkg${i}`], downloadBytes: 1, installedBytes: 50 * MiB, contentHash: String(i).repeat(64),
      packages: [{ name: `pkg${i}`, version: '1.0', fileName: `pkg${i}-1.0-py3-none-any.whl`, sha256: String(i).repeat(64), bytes: 1 }],
      lock: `pkg${i}==1.0 --hash=sha256:${String(i).repeat(64)}\n`,
    })
    bindSubmission(sent.id, c.revisionId, set.id)
  }
  forgetStock()
  const stock = await homeStock()
  const input = { stock, trusted: false, cards: false, sync: syncRequest(), leases: [], wantedBefore: new Map<string, Set<string>>() }
  runnerWant(input)
  const prepare = db.prepare.bind(db)
  let reads = 0
  ;(db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    if (/FROM dependency_bundles\b/.test(sql)) reads++
    return prepare(sql)
  }) as typeof db.prepare
  try {
    const again = runnerWant(input)
    assert.equal(again.want.bundles.length, 5)
  } finally {
    ;(db as { prepare: typeof db.prepare }).prepare = prepare
  }
  assert.equal(reads, 0, 'the sets\' rooms come with the stock, and their descriptions are kept')
})

/* ----------------------------------------------- #56 the card shares */

test('lowering «Посылок на карту» never leases more GPU runs than the cards hold at the new number', () => {
  reset()
  const c = competition({ gpu: true })
  for (let i = 0; i < 16; i++) send(c, { at: Date.now() - 100 + i })
  const m = machineRow()
  updateRunner(m.id, { perDevice: 8 })
  // The machine counted its shares at eight a card, as home last said: sixteen free on two idle cards.
  const cards = ['0', '1'].map((device) => ({ device, name: 'NVIDIA GeForce RTX 4090', memoryMb: 24_564, perDevice: 8, busyShares: 0 }))
  const sets = dataNow(c.id)
  const sync = syncRequest({ free: { slots: 32, memoryMb: 120_000, cpus: 31, gpuShares: 16, diskMb: 500_000 }, cards, ready: { revisions: [c.revisionId], data: [sets.open!.manifest], sealed: [], bundles: [] } })
  // The owner lowers it to two before the machine hears.
  const runner = updateRunner(m.id, { perDevice: 2 })!
  const taken = takeForRunner(runner, runnerOffer(runner, sync.free, sync), Date.now())
  assert.equal(taken.length, 4, 'two cards hold four runs at two a card')
  assert.ok(taken.every((lease) => lease.manifest.perDevice === 2))
  // Raised again, the machine's own count (in its old unit) holds until it hears: never more than it said was free.
  reset()
})

/* --------------------------------------------------- #57 one held sync */

test('a machine holds one sync at a time: its newer sync answers the older one at once', async () => {
  reset()
  competition()
  const m = await joined()
  await m.sync()
  const { heldSyncs } = await import('../server/src/competitions/remote/wake.js')
  const started = Date.now()
  const older = m.sync({ holdMs: 25_000 })
  await until('the first sync to be held', () => heldSyncs() === 1)
  const newer = m.sync({ holdMs: 25_000 })
  const first = await older
  assert.equal(first.status, 200)
  assert.ok(Date.now() - started < 5_000, 'the older one answered at once')
  await until('only the newer one held', () => heldSyncs() === 1)
  // Many at once: never more than one held.
  const many = Array.from({ length: 8 }, () => m.sync({ holdMs: 25_000 }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok(heldSyncs() <= 1, `${heldSyncs()} held`)
  const { wakeRunner } = await import('../server/src/competitions/remote/wake.js')
  // Something to say: the newest answers too.
  revokeRunner(m.runnerId)
  wakeRunner(m.runnerId)
  await Promise.all([newer, ...many])
})

/* ---------------------------------------------- #58 the completion reply */

test('a machine at its places gets its next lease in the reply to the outcome that freed one', async () => {
  reset()
  const c = competition()
  send(c, { at: Date.now() - 2 })
  const next = send(c, { at: Date.now() - 1 })
  const m = await joined({ approvedSlots: 1 })
  const ready = await readyFor(m, [c])
  const lease = (await m.sync({ ready, free: { ...FREE(1), slots: 1 } })).body.leases[0]
  assert.ok(lease)
  await m.sync({ seq: lease.seq, ready, free: { ...FREE(0), slots: 0 }, attempts: [{ id: lease.attemptId, phase: 'running', runningMs: 0 }] })
  assert.equal((await m.put(lease.attemptId, 'submission.csv', ANSWER)).status, 200)
  // The agent still counts the attempt it reports: no place left by its own count.
  const request = { ...finished(lease.attemptId, [{ name: 'submission.csv', body: ANSWER }]), free: { ...FREE(0), slots: 0, memoryMb: 28_000, cpus: 14 } }
  const out = await m.outcome(lease.attemptId, request)
  const leases = (out.body as RemoteOutcomeReply).leases
  assert.deepEqual(leases.map((one) => one.submissionId), [next.id], 'the next run, in the same reply')
})

/* ------------------------------------------------------ #63 the prune */

test('machines revoked or gone a month ago are pruned with their log; recent ones and standing ones stay', () => {
  reset()
  const now = Date.now()
  const old = machineRow()
  const recent = machineRow()
  const standing = machineRow()
  revokeRunner(old.id, now - REMOTE_RUNNERS_KEEP_MS - 60_000)
  revokeRunner(recent.id, now - REMOTE_RUNNERS_KEEP_MS + 60_000 * 60)
  assert.ok(runnerEvents(old.id).length > 0)
  const pruned = pruneRemoteRows(now)
  assert.ok(pruned.runners >= 1)
  assert.equal(getRunner(old.id), null)
  assert.equal(runnerEvents(old.id).length, 0, 'its log goes with it')
  assert.ok(getRunner(recent.id))
  assert.ok(getRunner(standing.id))
  reset()
})

/* ---------------------------------------- field note 7: the upload door */

test('a GPU competition whose notebooks only machines run is accepted without its own image here, when the metric\'s image is', async () => {
  reset({ homeNotebooks: false })
  const c = competition({ gpu: true })
  const light = portableRevision('kaggle-base')
  const own = competitionRevision(c.id)!
  const present = new Set(['28.3.1', light.imageDigest])
  const run = async (args: string[]) => {
    if (args[0] === 'version') return '28.3.1'
    const image = args.at(-1)!
    if (present.has(image)) return 'sha256:found'
    throw Object.assign(new Error(`Error: No such image: ${image}`), { stderr: `Error: No such image: ${image}` })
  }
  const reader = createCapabilityReader({ backend: () => 'docker', run, storageAvailable: () => true, catalogAvailable: () => true })
  // No machine with cards yet: the competition's own image is what the door asks for, and it is not here.
  assert.equal((await reader(c.environment, own.imageDigest, notebookNeeds(c))).execution.code, 'image_unavailable')
  const m = await joined()
  await m.sync({ cards: [{ device: '0', name: 'RTX 4090', memoryMb: 24_564, perDevice: 1, busyShares: 0 }] })
  const fresh = createCapabilityReader({ backend: () => 'docker', run, storageAvailable: () => true, catalogAvailable: () => true })
  assert.equal((await fresh(c.environment, own.imageDigest, notebookNeeds(c))).execution.available, true, 'the machines run it, and kaggle-base scores it here')
  // A CPU competition scores in its own image: with notebooks off, that image must still be here.
  const cpu = competition()
  const cpuOwn = competitionRevision(cpu.id)!
  assert.equal((await fresh(cpu.environment, cpuOwn.imageDigest, notebookNeeds(cpu))).execution.code, 'image_unavailable')
  reset()
})
