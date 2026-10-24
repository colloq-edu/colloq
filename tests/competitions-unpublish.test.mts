/**
 * «Снять с публикации» / «Опубликовать снова»: an open or finished competition
 * taken off /k and put back.
 *
 * What breaks quietly here is a door nobody remembered: the list hides it,
 * and the leaderboard, a file or the upload still answers by the old link —
 * the task the teacher took down is still handed out. So every participant
 * door is asked, and each must answer exactly as it does for a competition
 * that does not exist. And the way back must bring back what was there: the
 * entrants, their submissions and their scores, not a fresh start.
 */
import './_env.mts'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { ENTRANT_COOKIE, publicCompetition, shownOnK, type Competition } from '../shared/competitions.js'
import type { EntrantCompetitionList, EntrantLeaderboard, EntrantSubmissions, SubmissionAccepted } from '../shared/competitions-entrant.js'
import type { CompetitionView, CompetitionsList } from '../shared/competitions-api.js'
import { createTeacher, rotateLinkKey } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { listAdminEvents } from '../server/src/admin/audit-log.js'
import {
  acceptSubmission,
  createCompetition,
  getCompetition,
  getSubmission,
  listEntrantSubmissions,
  listCompetitionEntrants,
  putFile,
  queueRow,
  setCompetitionState,
} from '../server/src/competitions/store.js'
import { ensureCompetition, putOpenFile, putSecretFile, putSubmissionNotebook } from '../server/src/competitions/storage.js'
import { useCompetitionRunner } from '../server/src/competitions/runner-port.js'
import { drainCompetitionQueue } from '../server/src/competitions/runner.js'
import { competitionCardOf } from '../server/src/link-preview.js'
import { app } from '../server/src/app.js'

const DAY = 24 * 60 * 60 * 1000
let base = ''
let server: http.Server
let owner = ''
let runs = ''
let runsId = ''
let stranger = ''

function staffCookie(name: string, email: string, role: 'owner' | 'teacher'): { cookie: string; id: string } {
  const teacher = createTeacher({ name, email, role })
  assert.ok(teacher, email)
  rotateLinkKey(teacher.id)
  let value = ''
  issueStaffCookie({ cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse, teacher)
  return { cookie: `${STAFF_COOKIE}=${value}`, id: teacher.id }
}

/** A live competition of `runs`'s, open for a day more, with its files in place. */
function competition(slug: string): Competition {
  const made = createCompetition({
    slug,
    title: slug,
    metric: { name: 'MAPE', direction: 'lower', code: 'def score(solution, submission):\n    return 0.5\n' },
    limits: { perDay: 5 },
    deadlineAt: Date.now() + DAY,
    scoring: 'last',
    createdBy: runsId,
  })
  assert.ok(made)
  setCompetitionState(made.id, 'live')
  ensureCompetition(made.id)
  putOpenFile(made.id, 'sample_submission.csv', new TextEncoder().encode('id,target\n1,0\n2,0\n'))
  putFile({ competitionId: made.id, name: 'sample_submission.csv', bytes: 20, rows: 2, visibility: 'open' })
  putSecretFile(made.id, 'solution.csv', new TextEncoder().encode('id,target\n1,1\n2,2\n'))
  putFile({ competitionId: made.id, name: 'solution.csv', bytes: 20, rows: 2, visibility: 'hidden' })
  return getCompetition(made.id)!
}

before(async () => {
  useCompetitionRunner(null)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  owner = staffCookie('Хозяйка', 'unpublish.owner@example.edu', 'owner').cookie
  const teacher = staffCookie('Ведущий', 'unpublish.runs@example.edu', 'teacher')
  runs = teacher.cookie
  runsId = teacher.id
  stranger = staffCookie('Чужой', 'unpublish.stranger@example.edu', 'teacher').cookie
})
after(() => server?.close())

function cookieOf(res: Response): string | null {
  for (const line of res.headers.getSetCookie?.() ?? []) if (line.startsWith(`${ENTRANT_COOKIE}=`)) return line.split(';')[0]
  return null
}
function call(path: string, init: RequestInit & { cookie?: string | null } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' })
}
const notebook = (source = 'print(1)') =>
  JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', source, outputs: [], metadata: {}, execution_count: null }] })
async function join(slug: string, name: string) {
  const res = await call(`/api/k/competitions/${slug}/join`, { method: 'POST', body: JSON.stringify({ name }) })
  assert.equal(res.status, 200, `joining ${slug}`)
  const body = (await res.json()) as { entrant: { id: string } }
  return { cookie: cookieOf(res)!, id: body.entrant.id }
}
function uploadForm(body = notebook()) {
  const form = new FormData()
  form.append('file', new Blob([body]), 'solution.ipynb')
  return form
}
async function upload(slug: string, cookie: string, body = notebook()) {
  return call(`/api/k/competitions/${slug}/submissions`, { method: 'POST', body: uploadForm(body), cookie })
}
const unpublish = (id: string, cookie: string) => call(`/api/admin/competitions/${id}/unpublish`, { method: 'POST', cookie })
const republish = (id: string, cookie: string) => call(`/api/admin/competitions/${id}/republish`, { method: 'POST', cookie })

/**
 * Every participant door of one competition, as `[label, path, init]`: the
 * reads, the entrant's own and the writes. `slug` may name a competition that
 * does not exist — that is the answer each must give.
 */
function doors(slug: string, entrant: string, submissionId: string): [string, string, RequestInit & { cookie?: string | null }][] {
  const k = `/api/k/competitions/${slug}`
  return [
    ['page', k, {}],
    ['environment', `${k}/environment`, {}],
    ['environment freeze', `${k}/environment/freeze`, {}],
    ['leaderboard', `${k}/leaderboard`, { cookie: entrant }],
    ['open file', `${k}/files/sample_submission.csv`, {}],
    ['files archive', `${k}/files.zip`, {}],
    ['own submissions', `${k}/submissions`, { cookie: entrant }],
    ['own stream', `${k}/stream`, { cookie: entrant }],
    ['own notebook', `${k}/submissions/${submissionId}/notebook`, { cookie: entrant }],
    ['packages', `${k}/dependencies`, { cookie: entrant }],
    ['join', `${k}/join`, { method: 'POST', body: JSON.stringify({ name: '@latecomer' }) }],
    ['choose', `${k}/submissions/${submissionId}/choose`, { method: 'POST', cookie: entrant }],
    ['cancel', `${k}/submissions/${submissionId}/cancel`, { method: 'POST', cookie: entrant }],
  ]
}

async function answer(path: string, init: RequestInit & { cookie?: string | null }) {
  const res = await call(path, init)
  return { status: res.status, body: await res.text() }
}

test('hidden, every participant door answers as for a missing competition; shown again, everything is back unchanged', async () => {
  const c = competition('hide-me')
  const p = await join('hide-me', '@hidden_student')
  const sent = await upload('hide-me', p.cookie)
  assert.equal(sent.status, 200)
  const scoredId = ((await sent.json()) as SubmissionAccepted).submission.id
  await drainCompetitionQueue()
  const scored = getSubmission(scoredId)!
  assert.equal(scored.state, 'scored')
  const boardBefore = await (await call('/api/k/competitions/hide-me/leaderboard', { cookie: p.cookie })).text()
  const mineBefore = (await (await call('/api/k/competitions/hide-me/submissions', { cookie: p.cookie })).json()) as EntrantSubmissions
  const entrantsBefore = listCompetitionEntrants(c.id).map((e) => e.id).sort()
  const listed = (await (await call('/api/k/competitions')).json()) as EntrantCompetitionList
  assert.ok(listed.competitions.some((row) => row.competition.id === c.id))

  const hidden = await unpublish(c.id, runs)
  assert.equal(hidden.status, 200)
  const view = (await hidden.json()) as CompetitionView
  assert.ok(typeof view.competition.hiddenAt === 'number')
  // Not a return to draft: the state and the dates are as they were.
  assert.equal(view.competition.state, 'live')
  assert.equal(view.competition.deadlineAt, c.deadlineAt)

  // The public list leaves it out, signed in or not.
  for (const cookie of [null, p.cookie]) {
    const list = (await (await call('/api/k/competitions', { cookie })).json()) as EntrantCompetitionList
    assert.equal(list.competitions.some((row) => row.competition.id === c.id), false)
  }
  // Each door says what it says for a slug that names nothing — status and words.
  const missing = doors('no-such-competition', p.cookie, scoredId)
  for (const [i, [label, at, init]] of doors('hide-me', p.cookie, scoredId).entries()) {
    const got = await answer(at, init)
    const expected = await answer(missing[i][1], missing[i][2])
    assert.equal(got.status, 404, label)
    assert.deepEqual(got, expected, label)
  }
  // And by its id, not only by its slug.
  assert.deepEqual(await answer(`/api/k/competitions/${c.id}`, {}), await answer('/api/k/competitions/no-such-competition', {}))
  // A new notebook is refused the same way and reaches nothing.
  const refused = await upload('hide-me', p.cookie)
  assert.equal(refused.status, 404)
  assert.deepEqual(await refused.json(), await (await upload('no-such-competition', p.cookie)).json())
  assert.equal(listEntrantSubmissions(c.id, p.id).length, 1)
  // The link card in a chat knows nothing of it either.
  assert.equal(competitionCardOf('hide-me', 'ru'), null)

  const shown = await republish(c.id, runs)
  assert.equal(shown.status, 200)
  assert.equal(((await shown.json()) as CompetitionView).competition.hiddenAt, null)
  const list = (await (await call('/api/k/competitions')).json()) as EntrantCompetitionList
  assert.ok(list.competitions.some((row) => row.competition.id === c.id))
  assert.equal((await call('/api/k/competitions/hide-me')).status, 200)
  assert.equal((await call('/api/k/competitions/hide-me/files/sample_submission.csv')).status, 200)
  assert.notEqual(competitionCardOf('hide-me', 'ru'), null)
  // Entrants, submissions, scores and the board: what they were.
  assert.deepEqual(listCompetitionEntrants(c.id).map((e) => e.id).sort(), entrantsBefore)
  assert.deepEqual(getSubmission(scoredId), scored)
  assert.equal(await (await call('/api/k/competitions/hide-me/leaderboard', { cookie: p.cookie })).text(), boardBefore)
  const mineAfter = (await (await call('/api/k/competitions/hide-me/submissions', { cookie: p.cookie })).json()) as EntrantSubmissions
  assert.deepEqual(mineAfter.submissions, mineBefore.submissions)
  assert.deepEqual(publicCompetition(getCompetition(c.id)!), publicCompetition({ ...c, revision: getCompetition(c.id)!.revision }))
  // And the door is open again.
  assert.equal((await upload('hide-me', p.cookie)).status, 200)
})

test('staff keep the panel and the projector while it is hidden', async () => {
  const c = competition('hide-staff')
  await join('hide-staff', '@staff_view')
  assert.equal((await unpublish(c.id, runs)).status, 200)

  for (const at of [
    `/api/admin/competitions/${c.id}`,
    `/api/admin/competitions/${c.id}/live`,
    `/api/admin/competitions/${c.id}/leaderboard`,
    `/api/admin/competitions/${c.id}/submissions`,
    `/api/admin/competitions/${c.id}/entrants`,
    `/api/admin/competitions/${c.id}/materials.zip`,
  ]) {
    assert.equal((await call(at, { cookie: runs })).status, 200, at)
  }
  const list = (await (await call('/api/admin/competitions', { cookie: runs })).json()) as CompetitionsList
  const row = list.competitions.find((one) => one.competition.id === c.id)
  assert.ok(row && typeof row.competition.hiddenAt === 'number', 'the panel list keeps it, marked')
  // «Лидерборд на экран» reads /k with the staff cookie and `?audience=class`: the page and the board still open for whoever runs it…
  assert.equal((await call('/api/k/competitions/hide-staff?audience=class', { cookie: runs })).status, 200)
  const board = await call('/api/k/competitions/hide-staff/leaderboard?audience=class', { cookie: runs })
  assert.equal(board.status, 200)
  assert.ok(((await board.json()) as EntrantLeaderboard).public)
  // …and not for a teacher who does not run it, nor in the public list for anyone.
  for (const at of ['/api/k/competitions/hide-staff?audience=class', '/api/k/competitions/hide-staff/leaderboard?audience=class']) {
    assert.equal((await call(at, { cookie: stranger })).status, 404, at)
  }
  const publicList = (await (await call('/api/k/competitions', { cookie: runs })).json()) as EntrantCompetitionList
  assert.equal(publicList.competitions.some((one) => one.competition.id === c.id), false)
})

test('the console\'s «открыть» shows staff what a student sees: only the projector reads a hidden one', async () => {
  const c = competition('hide-peek')
  assert.equal((await unpublish(c.id, runs)).status, 200)
  // The staff who run it, cookie and all, but not the projector: every read is a missing competition's —
  // the page (no task, no join panel), the board, the environment, the files.
  const k = '/api/k/competitions'
  for (const [own, missing] of [
    [`${k}/hide-peek`, `${k}/no-such-competition`],
    [`${k}/hide-peek/leaderboard`, `${k}/no-such-competition/leaderboard`],
    [`${k}/hide-peek/environment`, `${k}/no-such-competition/environment`],
    [`${k}/hide-peek/environment?freeze`, `${k}/no-such-competition/environment?freeze`],
    [`${k}/hide-peek/environment/freeze`, `${k}/no-such-competition/environment/freeze`],
    [`${k}/hide-peek/files/sample_submission.csv`, `${k}/no-such-competition/files/sample_submission.csv`],
    [`${k}/hide-peek/files.zip`, `${k}/no-such-competition/files.zip`],
    // The projector's marker opens only its own two reads, never the task's files.
    [`${k}/hide-peek/files/sample_submission.csv?audience=class`, `${k}/no-such-competition/files/sample_submission.csv`],
    [`${k}/hide-peek/files.zip?audience=class`, `${k}/no-such-competition/files.zip`],
    [`${k}/hide-peek/environment?audience=class`, `${k}/no-such-competition/environment`],
  ]) {
    for (const cookie of [runs, owner]) {
      const got = await answer(own, { cookie })
      assert.equal(got.status, 404, own)
      assert.deepEqual(got, await answer(missing, { cookie }), own)
    }
  }
  // Shown again, the same staff read it as anyone does.
  assert.equal((await republish(c.id, runs)).status, 200)
  assert.equal((await call(`${k}/hide-peek`, { cookie: runs })).status, 200)
  assert.equal((await call(`${k}/hide-peek/files/sample_submission.csv`, { cookie: runs })).status, 200)
  // And the projector is the client that sends the marker on the page, as on the board.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const screen = fs.readFileSync(path.join(root, 'web/src/screens/CompetitionsScreen.svelte'), 'utf8')
  assert.match(screen, /entrantApi\.competition\(slug, route\.view === 'screen' \? 'class' : 'me'\)/)
  const api = fs.readFileSync(path.join(root, 'web/src/lib/entrantApi.ts'), 'utf8')
  assert.match(api, /competition: \(slug: string, audience: 'me' \| 'class' = 'me'\) =>\s+request<EntrantCompetitionView>\(`\/competitions\/\$\{encodeURIComponent\(slug\)\}\$\{audience === 'class' \? '\?audience=class' : ''\}`\)/)
})

test('the same people as «Открыть»: a teacher who does not run it is refused, a draft has nothing to take off', async () => {
  const c = competition('hide-rights')
  const foreign = await unpublish(c.id, stranger)
  assert.equal(foreign.status, 404, "someone else's competition answers like a missing one")
  assert.equal(getCompetition(c.id)!.hiddenAt, null)
  assert.equal((await call(`/api/admin/competitions/${c.id}/unpublish`, { method: 'POST' })).status, 401)

  // The owner may, as with every competition.
  assert.equal((await unpublish(c.id, owner)).status, 200)
  assert.equal((await republish(c.id, stranger)).status, 404)
  assert.ok(getCompetition(c.id)!.hiddenAt)
  assert.equal((await republish(c.id, runs)).status, 200)

  const draft = createCompetition({ slug: 'hide-draft', title: 'Черновик', createdBy: runsId })
  assert.ok(draft)
  const refused = await unpublish(draft.id, runs)
  assert.equal(refused.status, 409)
  assert.match(((await refused.json()) as { error: string }).error, /Черновик/)
  assert.equal(getCompetition(draft.id)!.hiddenAt, null)

  // A finished competition can be taken off too.
  setCompetitionState(c.id, 'finished')
  assert.equal((await unpublish(c.id, runs)).status, 200)
  assert.equal(getCompetition(c.id)!.state, 'finished')
})

test('each change goes into the audit log with who did it, and a second press writes nothing', async () => {
  const c = competition('hide-audit')
  const mark = Date.now()
  assert.equal((await unpublish(c.id, runs)).status, 200)
  assert.equal((await unpublish(c.id, runs)).status, 200)
  assert.equal((await republish(c.id, owner)).status, 200)
  assert.equal((await republish(c.id, owner)).status, 200)
  const events = listAdminEvents({ limit: 200 }).events
    .filter((event) => event.target?.id === c.id)
    .reverse()
  assert.deepEqual(events.map((event) => [event.action, event.actor?.email]), [
    ['competition.unpublished', 'unpublish.runs@example.edu'],
    ['competition.republished', 'unpublish.owner@example.edu'],
  ])
  for (const event of events) {
    assert.ok(event.at >= mark)
    assert.equal(event.target?.label, 'hide-audit')
  }
})

test('a run already queued when it is hidden finishes and is scored as usual', async () => {
  const c = competition('hide-queued')
  const p = await join('hide-queued', '@queued_student')
  const row = acceptSubmission({ competitionId: c.id, entrantId: p.id, fileName: 'queued.ipynb', bytes: 1 })
  putSubmissionNotebook(c.id, row.id, Buffer.from(notebook()))
  assert.ok(queueRow(row.id), 'waiting in the queue')
  assert.equal((await unpublish(c.id, runs)).status, 200)
  await drainCompetitionQueue()
  const done = getSubmission(row.id)!
  assert.equal(done.state, 'scored')
  assert.equal(typeof done.publicScore, 'number')
  assert.ok(getCompetition(c.id)!.hiddenAt, 'still hidden')
})

test('the rule is one question: neither a draft nor a hidden competition is on /k', () => {
  assert.equal(shownOnK({ state: 'live', hiddenAt: null }), true)
  assert.equal(shownOnK({ state: 'finished' }), true)
  assert.equal(shownOnK({ state: 'draft', hiddenAt: null }), false)
  assert.equal(shownOnK({ state: 'live', hiddenAt: 1 }), false)
  assert.equal(shownOnK({ state: 'finished', hiddenAt: 1 }), false)
  // The participant's copy never carries the mark.
  const c = getCompetition(createCompetition({ slug: 'hide-public', title: 'x' })!.id)!
  assert.equal('hiddenAt' in publicCompetition({ ...c, hiddenAt: 5 }), false)
})

/* -------------------------------------------------------------- migration */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('a database from before the column opens with every competition shown, and can hide one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-unpublish-'))
  try {
    fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 })
    fs.mkdirSync(path.join(root, 'workspace'))
    const env = {
      ...process.env,
      DATA_DIR: path.join(root, 'data'),
      WORKSPACE_DIR: path.join(root, 'workspace'),
      SESSION_SECRET: 'test-secret-not-random-on-purpose',
    }
    const store = JSON.stringify(path.join(repo, 'server/src/competitions/store.ts'))
    const run = (name: string, body: string) => {
      const probe = path.join(root, name)
      fs.writeFileSync(probe, `const s = await import(${store})\n${body}\nprocess.exit(0)\n`)
      const r = spawnSync(process.execPath, ['--import', 'tsx', probe], { cwd: repo, encoding: 'utf8', timeout: 60_000, env })
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`)
      return r.stdout
    }
    // A first boot writes today's schema and a live competition…
    run('first.mts', `const c = s.createCompetition({ slug: 'old-one', title: 'Old' }); s.setCompetitionState(c.id, 'live'); console.log('id=' + c.id)`)
    // …then the column is taken away, as a database of 0.28 has it.
    const db = path.join(root, 'data/colloq.db')
    execFileSync('python3', ['-c', `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('alter table competitions drop column hidden_at'); c.commit()
assert 'hidden_at' not in [r[1] for r in c.execute('pragma table_info(competitions)')]; c.close()`, db])
    const out = run('second.mts', `const c = s.findCompetition('old-one')
console.log('state=' + c.state + ' hidden=' + JSON.stringify(c.hiddenAt))
s.setCompetitionHidden(c.id, 123)
console.log('after=' + s.getCompetition(c.id).hiddenAt + ' state=' + s.getCompetition(c.id).state)`)
    assert.match(out, /state=live hidden=null/)
    assert.match(out, /after=123 state=live/)
    const columns = execFileSync('python3', ['-c', `import sqlite3,sys
print([r[1] for r in sqlite3.connect(sys.argv[1]).execute('pragma table_info(competitions)')])`, db], { encoding: 'utf8' })
    assert.match(columns, /'hidden_at'/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
