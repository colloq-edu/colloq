/**
 * The staff list is a list of live credentials. Three independent reviews found
 * real holes here, so the invariants that survived are pinned down.
 */
import './_env.mts'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHmac } from 'node:crypto'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import {
  countOwners,
  createTeacher,
  deleteTeacher,
  getTeacherByEmail,
  getTeacherByLinkKey,
  linkKeyOf,
  listTeachers,
  normalizeEmail,
  oldestOwner,
  rotateLinkKey,
  updateTeacherIdentity,
  updateTeacherRole,
} from '../server/src/admin/store.js'
import {
  issueStaffCookie,
  readSetupToken,
  staffFromCookieHeader,
  verifySetupToken,
} from '../server/src/admin/auth.js'
import { parseOraclePatch } from '../server/src/admin/settings.js'
import { app } from '../server/src/app.js'
import { createSession, getRules, isFinished, setRules, storedRules } from '../server/src/db.js'
import { COUNCIL_ROOM, isLectureRoom, LECTURE_ROOM, OPEN_ROOM } from '../shared/rules.js'
import { setPublicationSlug, writePublication } from '../server/src/publish/store.js'
import { sessionDir } from '../server/src/workspace.js'

/** issueStaffCookie writes onto express's Response; this is the smallest thing that shape. */
function mintCookie(teacher: Parameters<typeof issueStaffCookie>[1]): string {
  let value = ''
  const res = { cookie: (_n: string, v: string) => (value = v) } as unknown as Response
  issueStaffCookie(res, teacher)
  return `${STAFF_COOKIE}=${value}`
}

function fresh(name: string, email: string, role: 'owner' | 'teacher' = 'teacher') {
  const teacher = createTeacher({ name, email, role })
  assert.ok(teacher, `could not create ${email}`)
  rotateLinkKey(teacher.id)
  return teacher
}

test('an email is one identity however it was typed', () => {
  assert.equal(normalizeEmail('  Ada.Lovelace@EXAMPLE.EDU '), 'ada.lovelace@example.edu')
  const ada = fresh('Ada', 'Ada.Lovelace@EXAMPLE.EDU', 'owner')
  assert.equal(ada.email, 'ada.lovelace@example.edu')
  // The same person, shouted: a second row here is a second account nobody knows about.
  assert.equal(
    createTeacher({ name: 'Ada again', email: ' ADA.lovelace@example.edu ', role: 'teacher' }),
    null,
  )
  assert.ok(getTeacherByEmail('ada.lovelace@example.edu'))
})

test('a sign-in link is never in a listing', () => {
  const grace = fresh('Grace Hopper', 'grace@example.edu')
  const listed = listTeachers().find((t) => t.id === grace.id)
  assert.ok(listed)
  assert.equal(listed.hasLink, true)
  // hasLink says there is one; the key itself must not ride along.
  assert.equal(JSON.stringify(listed).includes(linkKeyOf(grace.id) ?? 'x'), false)
})

test('rotating a link kills the old one and every session opened from it', () => {
  const katherine = fresh('Katherine Johnson', 'katherine@example.edu')
  const oldKey = linkKeyOf(katherine.id)
  assert.ok(oldKey)
  const cookie = mintCookie(katherine)
  assert.equal(staffFromCookieHeader(cookie)?.id, katherine.id)

  const minted = rotateLinkKey(katherine.id)
  assert.ok(minted)
  assert.notEqual(minted.key, oldKey)
  // Revocation with no session table: the signature is over the link key, so
  // replacing the key invalidates every cookie ever signed with it.
  assert.equal(getTeacherByLinkKey(oldKey), null)
  assert.equal(staffFromCookieHeader(cookie), null)
  assert.equal(staffFromCookieHeader(mintCookie(minted.teacher))?.id, katherine.id)
})

test('deleting a teacher kills their cookie too', () => {
  const pavel = fresh('Pavel', 'pavel@example.edu')
  const cookie = mintCookie(pavel)
  assert.equal(staffFromCookieHeader(cookie)?.id, pavel.id)
  assert.equal(deleteTeacher(pavel.id), true)
  assert.equal(staffFromCookieHeader(cookie), null)
})

test('a forged or absent cookie is nobody', () => {
  const marina = fresh('Marina', 'marina@example.edu')
  const cookie = mintCookie(marina)
  const value = cookie.slice(STAFF_COOKIE.length + 1)
  const [body, sig] = [
    value.slice(0, value.lastIndexOf('.')),
    value.slice(value.lastIndexOf('.') + 1),
  ]

  assert.equal(staffFromCookieHeader(undefined), null)
  assert.equal(staffFromCookieHeader(''), null)
  assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=nonsense`), null)
  assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=${body}.tampered`), null)
  // Someone else's signature over your own id.
  const other = mintCookie(fresh('Other', 'other@example.edu'))
  const otherSig = other.slice(other.lastIndexOf('.') + 1)
  assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=${body}.${otherSig}`), null)
  assert.notEqual(sig, otherSig)
})

test('the owner count tracks promotion and demotion', () => {
  const before = countOwners()
  const dmitry = fresh('Dmitry', 'dmitry@example.edu')
  assert.equal(countOwners(), before)
  updateTeacherRole(dmitry.id, 'owner')
  assert.equal(countOwners(), before + 1)
  updateTeacherRole(dmitry.id, 'teacher')
  assert.equal(countOwners(), before)
})

test('a wrong setup token is refused and a right one is not', () => {
  assert.equal(verifySetupToken('definitely-not-it'), false)
  assert.equal(verifySetupToken(''), false)
  assert.equal(verifySetupToken(null), false)
  assert.equal(verifySetupToken(12345), false)
  /*
   * The positive half, without which the test name was untrue: a broken
   * verifySetupToken that always returns false passed all four checks above,
   * and this token is how the owner signs into the instance for the first
   * time, and the way back when the owner has lost their link.
   */
  assert.equal(verifySetupToken(readSetupToken()), true)
  // Spaces and a newline are part of the contract: the token is copied from a terminal.
  assert.equal(verifySetupToken(` ${readSetupToken()}\n`), true)
})

test('a teacher can be renamed without losing their link', () => {
  const mary = fresh('Mary Somervile', 'somervile@example.edu')
  const key = linkKeyOf(mary.id)

  const fixed = updateTeacherIdentity(mary.id, {
    name: 'Mary Somerville',
    email: 'M.Somerville@EXAMPLE.edu ',
  })
  assert.equal(fixed?.name, 'Mary Somerville')
  // The same address, normalized to one form, as on creation.
  assert.equal(fixed?.email, 'm.somerville@example.edu')
  // The point of the edit is that the link stays: otherwise it is deletion and creation anew.
  assert.equal(linkKeyOf(mary.id), key)
  assert.ok(getTeacherByEmail('m.somerville@example.edu'))
  assert.equal(getTeacherByEmail('somervile@example.edu'), null)
})

test('a rename onto somebody else’s address is refused, not merged', () => {
  const one = fresh('Sergey', 'sergey@example.edu')
  fresh('Olga', 'olga@example.edu')

  assert.equal(updateTeacherIdentity(one.id, { name: 'Sergey', email: 'olga@example.edu' }), null)
  // A refusal must not rename halfway.
  assert.equal(getTeacherByEmail('sergey@example.edu')?.id, one.id)
})

/* ------------------------------------------------------- the routes themselves */

/**
 * The panel rules live in the routes, not in the store, and until now they
 * were checked only by eye. A typo of `< 1` instead of `<= 1` in one line
 * leaves the instance without an owner: nobody will be able to add staff,
 * and the only way back is a shell on the server.
 */
let base = ''
let server: http.Server

before(async () => {
  /*
   * The APP is mounted, not a lookalike.
   *
   * There used to be an express assembly of its own here with the comment
   * "the same order as in index.ts", and a copy of the order does not catch
   * divergences, it repeats them: move the origin check relative to the
   * routers in the product, and these tests stay green. The order is now one
   * for everyone (server/src/app.ts), and the panel doors are checked behind
   * the same things they stand behind in a class: json parsing, the origin
   * of the write, the extension of the staff cookie.
   */
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

function call(
  method: string,
  path: string,
  init: { cookie?: string; origin?: string; body?: unknown } = {},
): Promise<globalThis.Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

test('the last owner cannot be demoted or removed', async () => {
  const owner = oldestOwner()
  assert.ok(owner)
  assert.equal(countOwners(), 1, 'this test only makes sense with a single owner')
  const cookie = mintCookie(owner)

  const demoted = await call('PATCH', `/api/admin/teachers/${owner.id}`, {
    cookie,
    body: { role: 'teacher' },
  })
  assert.equal(demoted.status, 409)
  const removed = await call('DELETE', `/api/admin/teachers/${owner.id}`, { cookie })
  assert.equal(removed.status, 409)
  // And the instance still belongs to someone: that is what all this was for.
  assert.equal(countOwners(), 1)
})

test('a teacher is refused the owner-only doors, and told which one', async () => {
  const teacher = fresh('Anna', 'anna.routes@example.edu')
  const refused = await call('POST', '/api/admin/teachers', {
    cookie: mintCookie(teacher),
    body: { name: 'Someone', email: 'someone.routes@example.edu' },
  })
  assert.equal(refused.status, 403)
  const body = (await refused.json()) as { error: string; reason: string }
  assert.equal(body.reason, 'forbidden')
  // The refusal names what is refused: "only an owner can …" about the staff list.
  assert.match(body.error, /список преподавателей/)
  assert.equal(getTeacherByEmail('someone.routes@example.edu'), null)
})

test('a write from somebody else’s page is refused before it is read', async () => {
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)

  const foreign = await call('POST', '/api/admin/teachers', {
    cookie,
    origin: 'https://evil.example',
    body: { name: 'Mallory', email: 'mallory.routes@example.edu' },
  })
  assert.equal(foreign.status, 403)
  assert.equal(getTeacherByEmail('mallory.routes@example.edu'), null)

  // From its own origin the same request goes through, otherwise the check forbids everything.
  const own = await call('POST', '/api/admin/teachers', {
    cookie,
    origin: base,
    body: { name: 'Mallory', email: 'mallory.routes@example.edu' },
  })
  assert.equal(own.status, 201)
})

test('the dev server on its own port is not somebody else', async () => {
  /*
   * `npm run dev` serves the page from :5173, and the proxy rewrites Host to
   * the server's address: Origin and Host always differ, and the panel
   * answered 403 to every write, including sign-in. For the browser it is one
   * site (SameSite does not look at the port), so there is no concession
   * here.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const dev = await call('POST', '/api/admin/teachers', {
    cookie: mintCookie(owner),
    origin: 'http://localhost:5173',
    body: { name: 'Dev', email: 'dev.routes@example.edu' },
  })
  assert.equal(dev.status, 201)
})

test('the share tunnel is our own address, though it arrives as 127.0.0.1', async () => {
  /*
   * `colloq start --share`: cloudflared arrives with Host 127.0.0.1:<port>
   * (scripts/host.sh substitutes it), while the page sends the Origin of the
   * tunnel address. Before the fix every POST from there got "a different
   * server address", and a sign-in link with a token on the public address
   * did not sign in. Our own address is the one the server itself hands out
   * as public (config.publicUrl).
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)
  const saved = { session: process.env.COLLOQ_LOCAL_SESSION, url: process.env.COLLOQ_LOCAL_URL }
  process.env.COLLOQ_LOCAL_SESSION = '1'
  process.env.COLLOQ_LOCAL_URL = 'https://plug-catalog.trycloudflare.com'
  try {
    const tunnel = await call('POST', '/api/admin/teachers', {
      cookie,
      origin: 'https://plug-catalog.trycloudflare.com',
      body: { name: 'Tunnel', email: 'tunnel.routes@example.edu' },
    })
    assert.equal(tunnel.status, 201)
    // Another tunnel is already a foreign site.
    const other = await call('POST', '/api/admin/teachers', {
      cookie,
      origin: 'https://other.trycloudflare.com',
      body: { name: 'Other', email: 'other.routes@example.edu' },
    })
    assert.equal(other.status, 403)
  } finally {
    if (saved.session === undefined) delete process.env.COLLOQ_LOCAL_SESSION
    else process.env.COLLOQ_LOCAL_SESSION = saved.session
    if (saved.url === undefined) delete process.env.COLLOQ_LOCAL_URL
    else process.env.COLLOQ_LOCAL_URL = saved.url
  }
  // Without a tunnel an address at *.trycloudflare.com is foreign again.
  const after = await call('POST', '/api/admin/teachers', {
    cookie,
    origin: 'https://plug-catalog.trycloudflare.com',
    body: { name: 'Late', email: 'late.routes@example.edu' },
  })
  assert.equal(after.status, 403)
})

test('the number of files on a card follows the folder', async () => {
  /*
   * The number on the card is computed with a cache, otherwise the list
   * walked every room's tree for every row, on every tab switch and every
   * twenty seconds, synchronously and in the same event loop that serves the
   * live rooms. The cache has exactly one price: it must notice a change in
   * the folder.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)
  const room = 'admin-files'
  createSession(room, 'Файлы', null)

  const shown = async (): Promise<number> => {
    const res = await call('GET', '/api/admin/seminars', { cookie })
    const rows = (await res.json()) as { id: string; fileCount: number }[]
    return rows.find((row) => row.id === room)?.fileCount ?? -1
  }

  assert.equal(await shown(), 0)
  fs.writeFileSync(path.join(sessionDir(room), 'data.csv'), 'a,b\n')
  assert.equal(await shown(), 1, 'the card shows an outdated number of files')
})

test('the seminar card names the page address, not its id', async () => {
  /*
   * A name set in the address is exactly the address the class was given;
   * the panel list was the only place printing the id instead of it. The
   * client prints and copies it, but it has nowhere to get `slug` from until
   * the list row carries it.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const room = 'admin-slug'
  createSession(room, 'Публикация', null)
  const pub = writePublication({
    sessionId: room,
    title: 'Неделя первая',
    by: null,
    steps: [],
    blobs: [],
  })
  assert.equal(setPublicationSlug(pub.id, 'week-one'), 'ok')

  const res = await call('GET', '/api/admin/seminars', { cookie: mintCookie(owner) })
  const rows = (await res.json()) as { id: string; publication: { slug: string | null } | null }[]
  assert.equal(rows.find((row) => row.id === room)?.publication?.slug, 'week-one')
})

test('the mode at creation is a rules preset, and whatever is sent goes on top', async () => {
  /*
   * The mode does not create a second state in the room next to the rules:
   * 'lecture' is `LECTURE_ROOM` written into the same row, and from then on
   * only the rules are asked what is allowed in the room. Two sources of
   * truth would drift apart at the first toggle in the settings.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)
  const made = async (body: unknown): Promise<string> => {
    const res = await call('POST', '/api/admin/seminars', { cookie, body })
    assert.equal(res.status, 201)
    return ((await res.json()) as { id: string }).id
  }

  const lecture = await made({ name: 'Лекция', mode: 'lecture' })
  assert.deepEqual(storedRules(lecture), LECTURE_ROOM)
  assert.equal(isLectureRoom(storedRules(lecture)), true)

  // No field means 'lab', that is, exactly what a seminar has always been.
  const lab = await made({ name: 'Лаборатория' })
  assert.deepEqual(storedRules(lab), OPEN_ROOM)

  // The person chose a mode and tweaked one row: the tweak beats the preset.
  const mixed = await made({
    name: 'Лекция, где спрашивают',
    mode: 'lecture',
    rules: { run: 'single', oracle: 'hints' },
  })
  assert.deepEqual(storedRules(mixed), { ...LECTURE_ROOM, run: 'single', oracle: 'hints' })

  // The third mode goes the same way: a council is written with its own preset.
  const council = await made({ name: 'Консилиум', mode: 'council' })
  assert.deepEqual(storedRules(council), COUNCIL_ROOM)
})

test('the mode works at every door: importing a notebook from disk knows the council', async () => {
  /*
   * The panel hides this hole: it always sends the full `rules` next to
   * `mode`, and the preset on the server is not consulted. A script or an
   * older client sends only `mode`, and then the server must know all three,
   * otherwise a council without rules would be created as an open room where
   * everyone types.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)
  const imported = async (mode: string | undefined): Promise<string> => {
    const res = await call('POST', '/api/admin/import/notebook', {
      cookie,
      body: {
        name: `Импорт ${mode ?? 'без режима'}`,
        filename: 'lecture.ipynb',
        cells: [{ cell_type: 'code', source: 'x = 1' }],
        ...(mode ? { mode } : {}),
      },
    })
    assert.equal(res.status, 201)
    return ((await res.json()) as { id: string }).id
  }

  assert.deepEqual(storedRules(await imported('council')), COUNCIL_ROOM)
  assert.deepEqual(storedRules(await imported('lecture')), LECTURE_ROOM)
  // Without a mode it is a lab, as with regular creation.
  assert.deepEqual(storedRules(await imported(undefined)), OPEN_ROOM)
  // A tweaked row beats the preset here too.
  const res = await call('POST', '/api/admin/import/notebook', {
    cookie,
    body: {
      name: 'Консилиум с подсказками',
      filename: 'x.ipynb',
      cells: [{ cell_type: 'code', source: 'x = 1' }],
      mode: 'council',
      rules: { oracle: 'hints' },
    },
  })
  assert.equal(res.status, 201)
  const id = ((await res.json()) as { id: string }).id
  assert.deepEqual(storedRules(id), { ...COUNCIL_ROOM, oracle: 'hints' })
})

test('the panel ends a class and reopens it', async () => {
  /*
   * The same door as the button in the room: a teacher who closed the tab
   * and remembered about it on the metro should not have to go back into it
   * for one press. Checked together with the list row returning the CHOSEN
   * rules: had it drawn the tightened ones in the settings, the panel would
   * write them back with the very first toggle, and there would be nothing
   * left to reopen the class into.
   */
  const owner = oldestOwner()
  assert.ok(owner)
  const cookie = mintCookie(owner)
  const room = 'admin-finish'
  createSession(room, 'Занятие', null)
  setRules(room, { ...OPEN_ROOM, run: 'room', edit: 'room' })

  const finished = await call('PATCH', `/api/admin/seminars/${room}`, {
    cookie,
    body: { finished: true },
  })
  assert.equal(finished.status, 200)
  const row = (await finished.json()) as {
    finishedAt: number | null
    status: string
    rules: { run: string }
  }
  assert.equal(typeof row.finishedAt, 'number', 'the list row did not name the time')
  /*
   * And the word in the list changed. An empty room and a finished class used
   * to be shown with the same `ended`, so the bell changed nothing in the
   * panel: you finished, and the row says the same as before.
   */
  assert.equal(row.status, 'finished', 'the word in the list did not notice the bell')
  assert.equal(row.rules.run, 'room', 'the settings got the tightening instead of the chosen rules')
  assert.equal(isFinished(room), true)
  assert.equal(getRules(room).run, 'host', 'the rights in the room stayed the same')

  const resumed = await call('PATCH', `/api/admin/seminars/${room}`, {
    cookie,
    body: { finished: false },
  })
  assert.equal(resumed.status, 200)
  const back = (await resumed.json()) as { finishedAt: number | null; status: string }
  assert.equal(back.finishedAt, null)
  /*
   * And the word went back to what is happening by itself. Nobody entered
   * this room, so it is `draft`, "the link has not been given yet"; had
   * people come and left, it would be `idle`. What matters is that
   * "finished" no longer sticks to an empty room.
   */
  assert.equal(back.status, 'draft')
  assert.equal(isFinished(room), false)
  // And the room came back to exactly the setup it was finished from.
  assert.equal(storedRules(room).run, 'room')
  assert.equal(getRules(room).run, 'room')
})

test('a cookie older than its month is nobody', () => {
  const boris = fresh('Boris', 'boris.routes@example.edu')
  const key = linkKeyOf(boris.id)
  assert.ok(key)
  const stale = (ageMs: number): string => {
    const body = Buffer.from(JSON.stringify({ tid: boris.id, iat: Date.now() - ageMs })).toString(
      'base64url',
    )
    const sig = createHmac('sha256', process.env.SESSION_SECRET as string)
      .update(`${body}.${key}`)
      .digest('base64url')
    return `${STAFF_COOKIE}=${body}.${sig}`
  }
  // Max-Age is a promise of the browser; the server ages the cookie itself,
  // otherwise a copied cookie lives forever.
  assert.equal(staffFromCookieHeader(stale(31 * 24 * 3_600_000)), null)
  assert.equal(staffFromCookieHeader(stale(60_000))?.id, boris.id)
})

test('a malformed cookie is nobody, not a crash', () => {
  /*
   * `decodeURIComponent('%')` throws URIError, and the same function is
   * called by role parsing on the socket handshake, where the exception went
   * to uncaughtException and brought down the process with all its rooms.
   * All it took was one participant with a link and one line in the browser
   * console.
   */
  for (const bad of ['%', '%E0%A4%A', '%%%', 'a%zz']) {
    assert.equal(staffFromCookieHeader(`${STAFF_COOKIE}=${bad}`), null, bad)
  }
  assert.equal(staffFromCookieHeader(`other=1; ${STAFF_COOKIE}=%; third=2`), null)
})

test('a patch of the oracle settings is refused by shape, not by luck', () => {
  assert.ok('error' in parseOraclePatch(null))
  assert.ok('error' in parseOraclePatch('everything'))
  assert.ok('error' in parseOraclePatch({ provider: 'nobody-ships-this' }))
  assert.ok('error' in parseOraclePatch({ model: 42 }))
  assert.ok('error' in parseOraclePatch({ questionsPerHour: 'many' }))
  assert.ok('error' in parseOraclePatch({ slowModeSeconds: 'поменьше' }))
  assert.ok('error' in parseOraclePatch({ defaultMode: 'shout' }))
  // The address the instance key will go to must be an address.
  assert.ok('error' in parseOraclePatch({ baseUrl: 'evil.example' }))

  const good = parseOraclePatch({ model: 'gpt-4o-mini', questionsPerHour: 5, baseUrl: '' })
  assert.ok('patch' in good)
  assert.equal(good.patch.model, 'gpt-4o-mini')
  // An empty string means "stop overriding", not a refusal.
  assert.equal(good.patch.baseUrl, '')
})
