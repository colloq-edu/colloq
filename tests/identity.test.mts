/**
 * Who you are when you come back, and who says so.
 *
 * Joining twice from the same browser has to land on the same person — a
 * refresh that turns one student into two ruins the participants list and the
 * carets with it. Joining as somebody ELSE has to be impossible, and that is
 * less obvious than it sounds: awareness broadcasts every participant id to the
 * whole room so a caret can be attributed to a face, which makes "I am p_xyz" a
 * sentence any student in the seminar can say about anybody in it.
 *
 * The role is the other half. It never comes from what the client stored — a
 * badge you can hand yourself is not a badge — and it has to be re-decided on
 * every join, because the same person can be a student at ten past and staff at
 * quarter past.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { signHostToken, verifyHostToken } from '../server/src/auth.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { createHmac } from 'node:crypto'
import { signToken, verifyToken, TOKEN_MAX_AGE_MS } from '../server/src/auth.js'
import { createSession, db, getParticipant, isTokenHost } from '../server/src/db.js'
import { roleFor, sessionAuth } from '../server/src/routes/sessions.js'
import { app } from '../server/src/app.js'
import type { JoinRequest, JoinResponse } from '../shared/protocol.js'
import { ApiError } from '../web/src/lib/api.js'
import { CROWD_WAIT_MS, retryJoinIn } from '../web/src/lib/crowd.js'

const ROOM = 'identity-test'
let base = ''
let server: http.Server

before(async () => {
  createSession(ROOM, 'Identity', null)
  /*
   * The whole app (server/src/app.ts), not two routers side by side: in the
   * product, join and history sit behind json parsing, the origin check and
   * the staff cookie renewal, and they have to be checked behind the same. An
   * express assembled here would repeat the order of index.ts rather than be
   * checked against it.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  base = `http://127.0.0.1:${port}`
})

after(() => server?.close())

/** issueStaffCookie writes onto express's Response; this is the smallest thing that shape. */
function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

/** The smallest thing sessionAuth reads: a bearer header, a cookie, and :id. */
function request(token: string, cookie?: string): Request {
  return {
    headers: { authorization: token ? `Bearer ${token}` : '', cookie },
    query: {},
    params: { id: ROOM },
  } as unknown as Request
}

async function join(body: JoinRequest, cookie?: string): Promise<JoinResponse> {
  const res = await fetch(`${base}/api/sessions/${ROOM}/join`, {
    method: 'POST',
    headers: cookie ? { 'content-type': 'application/json', cookie } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(res.status, 200)
  return (await res.json()) as JoinResponse
}

test('a refresh keeps the same person', async () => {
  const first = await join({ name: 'Maria' })
  const again = await join({
    name: 'Maria',
    participantId: first.participant.id,
    token: first.token,
  })
  assert.equal(again.participant.id, first.participant.id)
})

test('claiming an id without its token makes somebody new', async () => {
  /*
   * The id alone is not a secret — it is on every caret in the room. Presented
   * without the token that was minted with it, it buys nothing: the visitor is
   * a person the room has not met.
   */
  const maria = await join({ name: 'Maria' })
  const stranger = await join({ name: 'Not Maria', participantId: maria.participant.id })

  assert.notEqual(stranger.participant.id, maria.participant.id)
  const stored = getParticipant(ROOM, maria.participant.id)
  assert.equal(stored?.name, 'Maria', 'the row was overwritten by somebody else')
})

test('a token for another room does not open this one', async () => {
  const maria = await join({ name: 'Maria' })
  const elsewhere = signToken({
    sessionId: 'another-room',
    participantId: maria.participant.id,
    role: 'host',
  })
  const stranger = await join({
    name: 'Not Maria',
    participantId: maria.participant.id,
    token: elsewhere,
  })
  assert.notEqual(stranger.participant.id, maria.participant.id)
})

test('a token for another participant does not open this identity', async () => {
  const maria = await join({ name: 'Maria' })
  const john = await join({ name: 'John' })
  const stranger = await join({
    name: 'Not Maria',
    participantId: maria.participant.id,
    token: john.token,
  })
  assert.notEqual(stranger.participant.id, maria.participant.id)
})

test('the stored role is not a credential', async () => {
  /*
   * A browser holding a host token from an earlier life cannot spend it as a
   * claim: role is decided from the staff cookie and the host token, and a
   * participant token that merely SAYS host proves only which participant it is.
   */
  const maria = await join({ name: 'Maria' })
  const forged = signToken({
    sessionId: ROOM,
    participantId: maria.participant.id,
    role: 'host',
  })
  const back = await join({ name: 'Maria', participantId: maria.participant.id, token: forged })
  assert.equal(back.participant.id, maria.participant.id, 'it is still her')
  assert.equal(back.participant.role, 'participant', 'and she is still a student')
})

test('a wrong host token is refused rather than believed', async () => {
  const nobody = await join({ name: 'Maria', hostToken: 'not-a-token' })
  assert.equal(nobody.participant.role, 'participant')
})

/* ------------------------------------------- the same rule on both channels */

test('a teacher who joined as a student is a host to HTTP too', async () => {
  /*
   * The gap this closes. The WebSocket upgrade has always let a staff cookie
   * outrank the role a token was minted with — a teacher who opened the link
   * before signing in holds a participant token for a room that is theirs — but
   * sessionAuth read the token alone. So the same person in the same browser
   * could interrupt the kernel over the socket and be refused a checkpoint over
   * HTTP in the same second.
   */
  const teacher = createTeacher({ name: 'Ada', email: 'ada.identity@example.edu', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)

  const student = await join({ name: 'Ada' })
  assert.equal(student.participant.role, 'participant', 'joined before signing in')

  const asStudent = sessionAuth(request(student.token))
  assert.equal(asStudent?.role, 'participant')

  const asStaff = sessionAuth(request(student.token, mintCookie(teacher)))
  assert.equal(asStaff?.role, 'host', 'the cookie did not outrank the token')
  assert.equal(asStaff?.participantId, student.participant.id, 'and it is still them')
})

test('a staff cookie does not open a token minted for another room', () => {
  // The cookie raises a role; it never replaces the check that the credential
  // belongs to the seminar in the path.
  const teacher = createTeacher({ name: 'Grace', email: 'grace.identity@example.edu', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  const elsewhere = signToken({ sessionId: 'another-room', participantId: 'p_x', role: 'host' })
  assert.equal(sessionAuth(request(elsewhere, mintCookie(teacher))), null)
})

test('no credential at all is nobody, cookie or not', () => {
  const teacher = createTeacher({ name: 'Katherine', email: 'kj.identity@example.edu', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  assert.equal(sessionAuth(request('', mintCookie(teacher))), null)
})

/* ------------------------------------------------ a role cannot be baked in forever */

test('a token with role:host does not give host without a cookie', async () => {
  /*
   * The role is decided on every request and is never read from the token.
   * Otherwise host would be forever: a teacher removed from the list would
   * keep Restart and Restore in every room they ever entered — the token would
   * still say they are the owner.
   */
  const student = await join({ name: 'Ada' })
  const forged = signToken({ sessionId: ROOM, participantId: student.participant.id, role: 'host' })
  assert.equal(sessionAuth(request(forged))?.role, 'participant', 'a baked-in host survived the check')
})

test('a token older than the maximum age is not accepted', () => {
  const stale = signToken({
    sessionId: ROOM,
    participantId: 'p_old',
    role: 'participant',
    iat: Date.now() - TOKEN_MAX_AGE_MS - 1000,
  })
  assert.equal(verifyToken(stale), null, 'an eternal token is a capability handed out forever')
})

test('a token without a timestamp is read: a room in the middle of class must not get logged out', () => {
  const body = Buffer.from(
    JSON.stringify({ sessionId: ROOM, participantId: 'p_ageless', role: 'participant' }),
  ).toString('base64url')
  const sig = createHmac('sha256', process.env.SESSION_SECRET as string).update(body).digest('base64url')
  assert.equal(verifyToken(`${body}.${sig}`)?.participantId, 'p_ageless')
})

/* --------------------------------------------------- what the room accepts */

test('an avatar is a symbol, not a foreign address', async () => {
  /*
   * A string starting with http or data: is drawn in the room as <img src>:
   * one request — and the browser of EVERY participant, latecomers included,
   * goes to someone else's server, because the avatar appears both in the
   * roster and in the cell captions.
   */
  for (const bad of [
    'https://attacker.example/pixel.gif',
    'http://attacker.example/p.gif',
    'data:image/gif;base64,R0lGOD',
    'javascript:alert(1)',
  ]) {
    const joined = await join({ name: 'Pixel', avatar: bad })
    assert.equal(joined.participant.avatar, null, bad)
  }
  // An emoji is what the field exists for, and it arrives whole.
  const flag = await join({ name: 'Ada', avatar: '\u{1F469}\u200D\u{1F4BB}' })
  assert.equal(flag.participant.avatar, '\u{1F469}\u200D\u{1F4BB}')
})

test('the stream of new participants is limited: a loop does not bloat the room', async () => {
  /*
   * Joining requires nothing but the link, and without a proven
   * participantId+token pair it creates a row. A script in a loop wrote tens
   * of thousands of "people" nobody ever saw — and the list reached every real
   * participant in full.
   */
  const room = 'identity-flood'
  createSession(room, 'Поток', null)
  const knock = (body: JoinRequest, cookie?: string) =>
    fetch(`${base}/api/sessions/${room}/join`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })

  let refusedAt = 0
  let mine: JoinResponse | null = null
  // The loop's ceiling must be above `MAX_NEW_PARTICIPANTS`
  // (routes/sessions.ts): the limit was raised to six hundred, and a loop of
  // two hundred stopped reaching the refusal — that is, it checked that the
  // stream is NOT limited, and was green while doing so.
  for (let i = 1; i <= 800 && refusedAt === 0; i += 1) {
    const res = await knock({ name: `Гость ${i}` })
    if (res.status === 429) refusedAt = i
    else if (i === 1) mine = (await res.json()) as JoinResponse
  }
  assert.ok(refusedAt > 0, 'the loop did not meet a single refusal')

  // Someone already inside comes back with their token — the refusal does not
  // concern them.
  assert.ok(mine)
  const back = await knock({
    name: 'Гость 1',
    participantId: mine.participant.id,
    token: mine.token,
  })
  assert.equal(back.status, 200, 'the returning person was not let into their own room')

  // Nor the teacher: a room under a flood is run by someone real.
  const teacher = createTeacher({ name: 'Vera', email: 'vera.flood@example.edu', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  const staff = await knock({ name: 'Vera' }, mintCookie(teacher))
  assert.equal(staff.status, 200, 'staff could not enter their own room')
})

test('on a crowded join the tab knocks once more — and exactly once', () => {
  /*
   * The refusal above is not about this person: they came on time, just
   * together with the whole group. The tab should press a second time for
   * them (lib/crowd.ts), but exactly once: endless retries turn a crowded room
   * into one that "does not let you in at all", and do it silently.
   */
  const crowded = new ApiError('too many people are joining this seminar at once', 429)
  assert.equal(retryJoinIn(crowded, 1), CROWD_WAIT_MS, 'the first refusal did not wait for a retry')
  assert.equal(retryJoinIn(crowded, 2), null, 'the retry went around in circles')

  // Everything else is a refusal to the person, and there is nothing to wait
  // for: a taken name, no room, no connection. A retry would silently swallow
  // the explanation.
  assert.equal(retryJoinIn(new ApiError('session not found', 404), 1), null)
  assert.equal(retryJoinIn(new ApiError('Could not reach the server', 0), 1), null)
  assert.equal(retryJoinIn(new TypeError('Failed to fetch'), 1), null)
})

test('a temporary 404 from a proxy retries the join once without passing it off as a deleted room', () => {
  const proxyError = new ApiError('Не найдено (404)', 404)
  const wait = retryJoinIn(proxyError, 1)
  assert.ok(wait !== null && wait > 0 && wait <= 1000)
  assert.equal(retryJoinIn(proxyError, 2), null)
  assert.equal(retryJoinIn(new ApiError('session not found', 404), 1), null)
  for (const status of [401, 403, 500, 502, 503, 504]) {
    assert.equal(retryJoinIn(new ApiError('refused', status), 1), null)
  }
})

/* ------------------------------------------------ a deleted seminar takes its own along */

test('the history of a deleted seminar is not readable and does not revive the room', async () => {
  /*
   * The history routes were the only door through which a deleted seminar
   * stayed open: getSessionDoc builds a document for any id it is given — an
   * old token fetched the notebook of a room the panel had already reported
   * as gone, and put it back into memory along the way.
   */
  const gone = 'identity-gone'
  createSession(gone, 'Удалённый', null)
  const me = signToken({ sessionId: gone, participantId: 'p_x', role: 'participant' })
  db.prepare('DELETE FROM sessions WHERE id = ?').run(gone)

  const res = await fetch(`${base}/api/sessions/${gone}/history`, {
    headers: { authorization: `Bearer ${me}` },
  })
  assert.equal(res.status, 404)
})

test('the host key ages and cannot be rewritten', () => {
  const room = 'host-token-age'

  const fresh = signHostToken(room)
  assert.equal(verifyHostToken(room, fresh), true)

  // It does not fit another room, even when fresh.
  assert.equal(verifyHostToken('other-room', fresh), false)

  // The expiry sits in the key itself and is covered by the signature: it
  // cannot be extended without knowing the secret. That is exactly what is
  // tried here — rewriting the timestamp to tomorrow's.
  const [id, , sig] = fresh.split('.')
  const forged = `${id}.${(Date.now() + 86_400_000).toString(36)}.${sig}`
  assert.equal(verifyHostToken(room, forged), false, 'a forged expiry was accepted')

  // A key issued more than thirty days ago is no longer a key.
  const old = `${id}.${(Date.now() - 31 * 24 * 60 * 60 * 1000).toString(36)}.${sig}`
  assert.equal(verifyHostToken(room, old), false)

  // And the old two-part form — the one that never aged.
  assert.equal(verifyHostToken(room, `${id}.${sig}`), false, 'a key without expiry is still accepted')
})

test('a host by token survives a server restart', async () => {
  /*
   * The list of "who presented a host token" lived in process memory. After
   * `make stop` the author of a seminar created by a script came into their
   * room as a guest: the Restart and Interrupt buttons were dead, there was no
   * explanation, and no other key to this room exists — they have no cookie
   * by construction.
   *
   * The restart is simulated honestly here: we ask not what the module
   * remembers but what lies in the database.
   */
  const hostToken = signHostToken(ROOM)
  const author = await join({ name: 'Scripted', hostToken })
  assert.equal(author.participant.role, 'host', 'the token did not give host')

  assert.equal(
    isTokenHost(ROOM, author.participant.id),
    true,
    'after a process restart there will be nowhere to recall this from',
  )
  // And an ordinary student has no such record — otherwise it means nothing.
  const student = await join({ name: 'Nina' })
  assert.equal(isTokenHost(ROOM, student.participant.id), false)
})

test('joining over HTTP and over the socket give the same answer', async () => {
  /*
   * There were two functions, and they disagreed: HTTP looked into the set of
   * issued tokens, the socket knew nothing about it. The author of a scripted
   * seminar got `host` on the buttons and `participant` on the connection
   * those buttons work through — that is, buttons that do nothing.
   */
  const author = await join({ name: 'Scripted Two', hostToken: signHostToken(ROOM) })
  const student = await join({ name: 'Olga' })
  const teacher = createTeacher({ name: 'Emmy', email: 'emmy.identity@example.edu', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  const cookie = mintCookie(teacher)

  const cases = [
    { who: 'author by token', id: author.participant.id, cookie: undefined, expect: 'host' },
    { who: 'student', id: student.participant.id, cookie: undefined, expect: 'participant' },
    { who: 'student with a cookie', id: student.participant.id, cookie, expect: 'host' },
  ] as const

  for (const { who, id, cookie, expect } of cases) {
    const token = signToken({ sessionId: ROOM, participantId: id, role: 'participant' })
    const overHttp = sessionAuth(request(token, cookie))?.role
    const overSocket = roleFor(cookie, { sessionId: ROOM, participantId: id })
    assert.equal(overHttp, overSocket, `the joins disagree: ${who}`)
    // And it is not "both always participant" — otherwise the agreement is
    // worth nothing.
    assert.equal(overSocket, expect, `${who}: wrong role`)
  }
})

test('a cookie gives host only while it exists', async () => {
  // A cookie can be taken away — that is its point, and that is why "host by
  // cookie" is never written into the participant row.
  const teacher = createTeacher({ name: 'Sofia', email: 'sofia.identity@example.edu', role: 'teacher' })
  assert.ok(teacher)
  rotateLinkKey(teacher.id)
  const joined = await join({ name: 'Sofia' }, mintCookie(teacher))
  assert.equal(joined.participant.role, 'host', 'the cookie did not give host on join')
  assert.equal(
    isTokenHost(ROOM, joined.participant.id),
    false,
    'the cookie join was recorded forever — there is nothing left to revoke the rights with',
  )
  assert.equal(roleFor(undefined, { sessionId: ROOM, participantId: joined.participant.id }), 'participant')
})
