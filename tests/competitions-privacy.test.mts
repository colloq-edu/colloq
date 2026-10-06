/**
 * Students' contacts on competition boards: who reads a name whole, who reads
 * it shortened, and who reads the board at all.
 *
 * An entrant's name is a Telegram username or an email address (the owner's
 * rule, so that a teacher can reach every person on the board). For a
 * university a public list of students' mailboxes with their results is a
 * disclosure, and each check below closes one way it used to leak: a board
 * handed to anyone with the link, an address printed in full to classmates,
 * the projector showing the teacher's view to the room, the leader's number
 * on a closed board's card, a live stream that could one day carry a row.
 */
import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { ENTRANT_COOKIE, maskEntrantName } from '../shared/competitions.js'
import type { EntrantBoardLine, EntrantCompetitionList, EntrantLeaderboard } from '../shared/competitions-entrant.js'
import type { CompetitionView } from '../shared/competitions-api.js'
import { avatarLetter, avatarTint } from '../web/src/lib/competition-words.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { parseCompetitionInput } from '../server/src/competitions/panel.js'
import {
  acceptSubmission,
  createCompetition,
  getCompetition,
  leaveQueue,
  setCompetitionState,
  updateCompetition,
  updateSubmission,
} from '../server/src/competitions/store.js'
import { db } from '../server/src/db.js'
import { app } from '../server/src/app.js'

/* ------------------------------------------------------- the mask itself */

test('an address keeps three characters of its local part and its domain', () => {
  assert.equal(maskEntrantName('ivanov@hse.ru'), 'iva…@hse.ru')
  assert.equal(maskEntrantName('ivan.petrov@mail.ru'), 'iva…@mail.ru')
  assert.equal(maskEntrantName('abcd@x.ru'), 'abc…@x.ru')
})

test('a local part of three characters or fewer keeps one', () => {
  assert.equal(maskEntrantName('abc@x.ru'), 'a…@x.ru')
  assert.equal(maskEntrantName('ab@x.ru'), 'a…@x.ru')
  assert.equal(maskEntrantName('a@x.ru'), 'a…@x.ru')
})

test('capitals, plus-addressing and Unicode are masked, never cut in half', () => {
  // A name from before the rule may carry capitals: kept as written.
  assert.equal(maskEntrantName('IVANOV@HSE.RU'), 'IVA…@HSE.RU')
  // The tag after "+" is part of the local part, and hidden with it.
  assert.equal(maskEntrantName('ivan+olymp2026@gmail.com'), 'iva…@gmail.com')
  assert.equal(maskEntrantName('a+b@x.ru'), 'a…@x.ru')
  // Counted in code points: a Cyrillic or an emoji local part stays whole letters.
  assert.equal(maskEntrantName('иванов@почта.рф'), 'ива…@почта.рф')
  assert.equal(maskEntrantName('😀😀😀😀@x.ru'), '😀😀😀…@x.ru')
  assert.equal(maskEntrantName('ёж@x.ru'), 'ё…@x.ru')
})

test('a Telegram username and a name that is neither stay as they are', () => {
  assert.equal(maskEntrantName('@anna_kim'), '@anna_kim')
  assert.equal(maskEntrantName('Анна Ким'), 'Анна Ким')
  assert.equal(maskEntrantName('Базовое решение'), 'Базовое решение')
  assert.equal(maskEntrantName(''), '')
  assert.equal(maskEntrantName('  @anna_kim  '), '@anna_kim')
})

test('anything with a local part before its last "@" is treated as an address', () => {
  // Not addresses by the strict pattern, but a leak is a leak.
  assert.equal(maskEntrantName('ivan@'), 'iva…@')
  assert.equal(maskEntrantName('ivan petrov@mail.ru'), 'iva…@mail.ru')
  assert.equal(maskEntrantName('a@b@c.ru'), 'a…@c.ru')
  assert.equal(maskEntrantName('@ivan@mail.ru'), '@iv…@mail.ru')
})

test('no more than three characters of any local part survive', () => {
  for (const local of ['maria', 'm.smirnova', 'student2026', 'x_y_z_w']) {
    const shown = maskEntrantName(`${local}@hse.ru`)
    assert.ok(!shown.includes(local), `${local} leaked whole`)
    assert.ok(shown.endsWith('…@hse.ru'))
    assert.ok(shown.length <= 3 + '…@hse.ru'.length)
  }
})

test('the avatar letter reads a shortened name the way it reads the whole one', () => {
  assert.equal(avatarLetter(maskEntrantName('ivanov@hse.ru')), 'I')
  assert.equal(avatarLetter('ivanov@hse.ru'), 'I')
  assert.equal(avatarLetter('@max_zaitsev'), 'M')
  assert.equal(avatarLetter(maskEntrantName('иванов@почта.рф')), 'И')
  // Nothing of the local part left to read: the domain's letter, not "?" or "…".
  assert.equal(avatarLetter(maskEntrantName('_ab@hse.ru')), 'H')
  assert.match(avatarTint(maskEntrantName('ivanov@hse.ru')), /^#[0-9A-F]{6}$/)
})

/* ------------------------------------------------------------ the doors */

let base = ''
let server: http.Server
let slug = ''
let competitionId = ''
let otherSlug = ''

function cookieOf(res: Response): string | null {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    if (line.startsWith(`${ENTRANT_COOKIE}=`)) return line.split(';')[0]
  }
  return null
}

let teacherId: string | null = null

function staffCookie(name: string, email: string, role: 'owner' | 'teacher'): string {
  const teacher = createTeacher({ name, email, role })
  assert.ok(teacher, email)
  rotateLinkKey(teacher.id)
  if (role === 'teacher') teacherId = teacher.id
  let value = ''
  issueStaffCookie({ cookie: (_name: string, cookie: string) => (value = cookie) } as unknown as ExpressResponse, teacher)
  return `${STAFF_COOKIE}=${value}`
}

function call(path: string, init: RequestInit & { cookie?: string | null } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
}

async function join(where: string, name: string): Promise<{ cookie: string; id: string }> {
  const res = await call(`/api/k/competitions/${where}/join`, { method: 'POST', body: JSON.stringify({ name }) })
  assert.equal(res.status, 200, `joining ${name}`)
  const cookie = cookieOf(res)
  assert.ok(cookie)
  return { cookie, id: ((await res.json()) as { entrant: { id: string } }).entrant.id }
}

let at = Date.now() - 60_000
function scored(competition: string, entrantId: string, score: number) {
  const submission = acceptSubmission({ competitionId: competition, entrantId, fileName: 'x.ipynb', bytes: 10, at: at++ })
  leaveQueue(submission.id)
  updateSubmission(submission.id, { state: 'scored', stage: 'score', publicScore: score, privateScore: score, cellsDone: 1 })
  return submission
}

let ivanov: { cookie: string; id: string }
let petrova: { cookie: string; id: string }
let telegram: { cookie: string; id: string }
let stranger: { cookie: string; id: string }
let teacher = ''

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  // Made first: the competitions are the teacher's own, and staff exemptions on
  // the board belong to staff who run the competition (competitions/scope.ts).
  teacher = staffCookie('Преподаватель', 'teacher.privacy@example.edu', 'teacher')

  const made = createCompetition({
    slug: 'privacy-k',
    title: 'Приватность',
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(a, b):\n    return 0\n' },
    limits: { perDay: 20 },
    createdBy: teacherId,
  })
  assert.ok(made)
  slug = made.slug
  competitionId = made.id
  setCompetitionState(competitionId, 'live')
  const other = createCompetition({ slug: 'privacy-other', title: 'Соседнее', createdBy: teacherId })
  assert.ok(other)
  otherSlug = other.slug
  setCompetitionState(other.id, 'live')

  ivanov = await join(slug, 'Ivanov@HSE.ru')
  petrova = await join(slug, 'petrova+olymp@hse.ru')
  telegram = await join(slug, '@tele_gram')
  stranger = await join(otherSlug, 'stranger@hse.ru')
  scored(competitionId, ivanov.id, 0.3)
  scored(competitionId, petrova.id, 0.1)
  scored(competitionId, telegram.id, 0.2)
})

after(() => server?.close())

async function board(cookie: string | null, query = ''): Promise<{ status: number; text: string; lines: EntrantBoardLine[] }> {
  const res = await call(`/api/k/competitions/${slug}/leaderboard${query}`, { cookie })
  const text = await res.text()
  const lines = res.ok ? (JSON.parse(text) as EntrantLeaderboard).public : []
  return { status: res.status, text, lines }
}

const names = (lines: EntrantBoardLine[]) => lines.map((line) => line.name)

test('a visitor without a cookie reads every address shortened, and usernames whole', async () => {
  const seen = await board(null)
  assert.equal(seen.status, 200)
  assert.deepEqual(names(seen.lines), ['pet…@hse.ru', '@tele_gram', 'iva…@hse.ru'])
  assert.ok(!seen.text.includes('ivanov@'), 'a full address leaked to a stranger')
  assert.ok(!seen.text.includes('petrova'), 'a full address leaked to a stranger')
  // Places stay one per row, whoever reads them.
  assert.deepEqual(seen.lines.map((line) => line.place), [1, 2, 3])
})

test('an entrant reads their own name whole and everyone else\'s address shortened', async () => {
  const seen = await board(ivanov.cookie)
  assert.deepEqual(names(seen.lines), ['pet…@hse.ru', '@tele_gram', 'ivanov@hse.ru'])
  assert.equal(seen.lines.find((line) => line.you)?.name, 'ivanov@hse.ru')
  assert.ok(!seen.text.includes('petrova+olymp'), "a classmate's address leaked")
})

test('an entrant of another competition reads the public board the way a stranger does', async () => {
  const seen = await board(stranger.cookie)
  assert.equal(seen.status, 200)
  assert.deepEqual(names(seen.lines), ['pet…@hse.ru', '@tele_gram', 'iva…@hse.ru'])
  assert.ok(seen.lines.every((line) => !line.you))
})

test('staff read every name whole, on the student-facing board too', async () => {
  const seen = await board(teacher)
  assert.deepEqual(names(seen.lines), ['petrova+olymp@hse.ru', '@tele_gram', 'ivanov@hse.ru'])
})

test('the projector gets the class\'s view even from the teacher\'s browser', async () => {
  const seen = await board(teacher, '?audience=class')
  assert.deepEqual(names(seen.lines), ['pet…@hse.ru', '@tele_gram', 'iva…@hse.ru'])
  // And for an entrant the parameter changes nothing: their own row stays theirs.
  const own = await board(ivanov.cookie, '?audience=class')
  assert.equal(own.lines.find((line) => line.you)?.name, 'ivanov@hse.ru')
})

test('the final board is shortened by the same rule once it opens', async () => {
  updateCompetition(competitionId, { privateRelease: 'manual' })
  db.prepare('UPDATE competitions SET private_opened_at = ? WHERE id = ?').run(Date.now(), competitionId)
  try {
    const res = await call(`/api/k/competitions/${slug}/leaderboard`, { cookie: telegram.cookie })
    const body = (await res.json()) as EntrantLeaderboard
    assert.ok(body.private)
    assert.deepEqual(body.private.map((line) => line.name), ['pet…@hse.ru', '@tele_gram', 'iva…@hse.ru'])
  } finally {
    db.prepare('UPDATE competitions SET private_opened_at = NULL WHERE id = ?').run(competitionId)
  }
})

test('the list of competitions and the page carry no names at all', async () => {
  for (const path of ['/api/k/competitions', `/api/k/competitions/${slug}`]) {
    const res = await call(path, { cookie: ivanov.cookie })
    const text = await res.text()
    assert.equal(res.status, 200, path)
    assert.ok(!text.includes('petrova') && !text.includes('pet…'), `${path} carries a classmate's name`)
  }
})

test("the live stream carries only the person's own submissions, nothing of anyone else", async () => {
  const waiting = acceptSubmission({ competitionId, entrantId: petrova.id, fileName: 'mine.ipynb', bytes: 10 })
  const control = new AbortController()
  const res = await call(`/api/k/competitions/${slug}/stream`, { cookie: petrova.cookie, signal: control.signal })
  assert.equal(res.status, 200)
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (!buffer.includes('\n\n')) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    control.abort()
    leaveQueue(waiting.id)
    updateSubmission(waiting.id, { state: 'cancelled' })
  }
  for (const other of [ivanov.id, telegram.id, 'ivanov', 'tele_gram', 'iva…']) {
    assert.ok(!buffer.includes(other), `the stream carries ${other}`)
  }
})

/* ------------------------------------------------------------ visibility */

test('a competition is public by default, and a row from before the setting reads as public', () => {
  assert.equal(getCompetition(competitionId)?.boardVisibility, 'public')
  // A row written the way the previous release wrote it, without the column.
  db.prepare(`INSERT INTO competitions (id, slug, title, split_seed, created_at, updated_at)
    VALUES ('legacyrow', 'legacy-row', 'Old', 'seed', 0, 0)`).run()
  assert.equal(getCompetition('legacyrow')?.boardVisibility, 'public')
})

test('the setting is parsed as one of two words and nothing else', () => {
  assert.deepEqual(parseCompetitionInput({ boardVisibility: 'entrants' }), { input: { boardVisibility: 'entrants' } })
  assert.deepEqual(parseCompetitionInput({ boardVisibility: 'public' }), { input: { boardVisibility: 'public' } })
  assert.deepEqual(parseCompetitionInput({ boardVisibility: 'everyone' }), {
    refusal: { field: 'boardVisibility', why: 'value' },
  })
  // Absent means untouched: the "Settings" tab sends only what it showed.
  assert.deepEqual(parseCompetitionInput({ title: 'x' }), { input: { title: 'x' } })
})

test('the teacher closes the board to entrants from the editor, and the answer says so', async () => {
  const res = await call(`/api/admin/competitions/${competitionId}`, {
    method: 'PATCH',
    cookie: teacher,
    body: JSON.stringify({ boardVisibility: 'entrants' }),
  })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as CompetitionView).competition.boardVisibility, 'entrants')
  // The page tells the class the board is closed, so it can say why.
  const page = await call(`/api/k/competitions/${slug}`)
  assert.equal(((await page.json()) as { competition: { boardVisibility: string } }).competition.boardVisibility, 'entrants')
})

test('a closed board refuses a stranger and another competition\'s entrant, in a word the page names', async () => {
  const anonymous = await board(null)
  assert.equal(anonymous.status, 401)
  assert.equal(JSON.parse(anonymous.text).reason, 'board_closed')
  assert.match(JSON.parse(anonymous.text).error, /только его участники/)
  const outsider = await board(stranger.cookie)
  assert.equal(outsider.status, 403)
  assert.equal(JSON.parse(outsider.text).reason, 'board_closed')
  assert.ok(!outsider.text.includes('hse.ru'), 'the refusal carries names')
})

test('a closed board is open to its entrants and to staff, with the same shortening', async () => {
  const member = await board(petrova.cookie)
  assert.equal(member.status, 200)
  assert.deepEqual(names(member.lines), ['petrova+olymp@hse.ru', '@tele_gram', 'iva…@hse.ru'])
  const staff = await board(teacher)
  assert.equal(staff.status, 200)
  assert.deepEqual(names(staff.lines), ['petrova+olymp@hse.ru', '@tele_gram', 'ivanov@hse.ru'])
  // The projector keeps working from the teacher's browser, in the class's view.
  const projector = await board(teacher, '?audience=class')
  assert.equal(projector.status, 200)
  assert.deepEqual(names(projector.lines), ['pet…@hse.ru', '@tele_gram', 'iva…@hse.ru'])
})

test("a closed board's card keeps the leader's number from strangers, and gives members their own", async () => {
  const row = async (cookie: string | null) => {
    const res = await call('/api/k/competitions', { cookie })
    return ((await res.json()) as EntrantCompetitionList).competitions.find((one) => one.competition.slug === slug)!
  }
  assert.equal((await row(null)).bestPublic, null)
  assert.equal((await row(stranger.cookie)).bestPublic, null)
  assert.equal((await row(ivanov.cookie)).bestPublic, 0.1)
  const page = await call(`/api/k/competitions/${slug}`, { cookie: stranger.cookie })
  assert.equal(((await page.json()) as { bestPublic: number | null }).bestPublic, null)
})

test('opening the board again brings back the public view', async () => {
  const res = await call(`/api/admin/competitions/${competitionId}`, {
    method: 'PATCH',
    cookie: teacher,
    body: JSON.stringify({ boardVisibility: 'public' }),
  })
  assert.equal(res.status, 200)
  assert.equal((await board(null)).status, 200)
  assert.equal((await board(stranger.cookie)).status, 200)
})
