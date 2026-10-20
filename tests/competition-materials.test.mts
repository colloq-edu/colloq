/**
 * «Скачать материалы»: a competition's materials for another teacher of the
 * course, as one archive and file by file (routes/admin-competitions.ts,
 * competitions/materials-zip.ts).
 *
 * What it must never do is let out what only the metric may read — the
 * answers — or anything of a person: an entrant's name or key, a
 * submission, the split seed. What it must do is give everyone who may open
 * the competition in the editor everything else, laid out so a colleague can
 * read it or build it again, and say in the audit log who took the hidden
 * test. The archive is checked entry by entry, every CRC included, or a
 * teacher gets a ZIP that will not open.
 */
import './_env.mts'
import zlib from 'node:zlib'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCourse } from '../server/src/publish/store.js'
import { addCourseTeacher } from '../server/src/admin/access.js'
import { listAdminEvents } from '../server/src/admin/audit-log.js'
import {
  acceptSubmission,
  createCompetition,
  getCompetition,
  joinAsNewcomer,
  putFile,
  setQueuePaused,
} from '../server/src/competitions/store.js'
import { ensureCompetition, putBaseline, putOpenFile, putSealedFile, putSecretFile, putSubmissionNotebook } from '../server/src/competitions/storage.js'
import { materialsSettings, materialsTop, type MaterialsInput } from '../server/src/competitions/materials-zip.js'
import { putRevision, selectRevision } from '../server/src/dependencies/store.js'
import type { Competition } from '../shared/competitions.js'
import type { AdminAuditEvent } from '../shared/admin.js'
import { call, staffMember, startApp, type Running } from './_scoping.mts'

let app: Running
const owner = staffMember('Владелица Материалов', 'owner')
/** Made the competition. */
const author = staffMember('Автор Соревнования')
/** Teaches the competition's course, made nothing: the colleague the archive is for. */
const colleague = staffMember('Коллега По Курсу')
/** Neither: the competition is not theirs to see. */
const stranger = staffMember('Чужой Преподаватель')

const bytes = (text: string) => new TextEncoder().encode(text)

const DESCRIPTION = '## Задача\n\nПредскажите `target` для каждого `id`.\n'
const METRIC = 'def score(solution, submission):\n    return 0.5  # the teacher\'s own\n'
const TRAIN = 'id,x,y\n1,0.5,1\n2,0.25,0\n'
const EXAMPLE = 'id,x\n3,0.75\n'
const HIDDEN = 'id,x\nHIDDEN-ROW,1\n'
const ANSWERS = 'id,y\nANSWER-ROW,1\n'
const BASELINE = '{"cells":[{"cell_type":"code","source":"print(1)","metadata":{},"outputs":[]}],"metadata":{},"nbformat":4,"nbformat_minor":5}'

let course = ''
/** With every kind of material, an entrant and a submission. */
let full: Competition
/** Open data and answers only: no hidden test, no sample notebook. */
let plain: Competition
let entrantName = ''
let entrantKey = ''
let submissionId = ''

function made(slug: string, over: Partial<Parameters<typeof createCompetition>[0]> = {}): Competition {
  const competition = createCompetition({
    slug,
    title: `Материалы ${slug}`,
    blurb: 'Одна строка для списка',
    description: DESCRIPTION,
    metric: { name: 'RMSE', direction: 'lower', code: METRIC },
    createdBy: author.teacher.id,
    courseId: course,
    limits: { wallSeconds: 900, memoryMb: 2048, cpus: 2, perDay: 3 },
    ...over,
  })
  assert.ok(competition)
  ensureCompetition(competition.id)
  const open = (name: string, body: string, rows: number) => {
    const stored = putOpenFile(competition.id, name, bytes(body))
    putFile({ competitionId: competition.id, name, bytes: stored.bytes, rows, visibility: 'open', sha256: stored.sha256 })
  }
  open('train.csv', TRAIN, 2)
  open('test.csv', EXAMPLE, 1)
  putSecretFile(competition.id, 'solution.csv', bytes(ANSWERS))
  putFile({ competitionId: competition.id, name: 'solution.csv', bytes: ANSWERS.length, rows: 1, visibility: 'hidden' })
  return getCompetition(competition.id)!
}

before(async () => {
  app = await startApp()
  // Nothing here may be taken by the pump: the submission is a row to keep out of the archive.
  setQueuePaused(true)
  course = createCourse('Курс с материалами', null, author.teacher.name).id
  addCourseTeacher(course, author.teacher.id, null)
  addCourseTeacher(course, colleague.teacher.id, null)

  full = made('materials-full')
  // A hidden test under the open example's name: the archive keeps both, apart.
  const sealed = putSealedFile(full.id, 'test.csv', bytes(HIDDEN))
  putFile({ competitionId: full.id, name: 'test.csv', bytes: sealed.bytes, rows: 1, visibility: 'sealed', sha256: sealed.sha256 })
  putBaseline(full.id, bytes(BASELINE))
  const revision = putRevision({
    environmentName: 'base', imageDigest: 'sha256:materials', pythonVersion: '3.11.16', pythonAbi: 'cp311',
    platform: 'linux/amd64', packages: [{ name: 'numpy', version: '2.4.6' }, { name: 'pandas', version: '2.3.3' }], baseConstraintsHash: 'hash',
  })
  selectRevision(full.id, revision.id)
  // A person and their work: none of it may ride out in the archive.
  const joined = joinAsNewcomer(full.id, 'leaky.entrant@example.edu')
  assert.ok(joined !== 'taken')
  entrantName = joined.entrant.name
  entrantKey = joined.key
  const submission = acceptSubmission({ competitionId: full.id, entrantId: joined.entrant.id, fileName: 'mine.ipynb', bytes: 10 })
  putSubmissionNotebook(full.id, submission.id, bytes(BASELINE))
  submissionId = submission.id

  plain = made('materials-plain')
})
after(() => app?.close())

/** Every stored entry of an archive by its local headers, each CRC checked against its body. */
function entries(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let at = 0
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const crc = zip.readUInt32LE(at + 14)
    const size = zip.readUInt32LE(at + 18)
    const nameLength = zip.readUInt16LE(at + 26)
    const extra = zip.readUInt16LE(at + 28)
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8')
    const body = zip.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size)
    assert.equal(zlib.crc32(body) >>> 0, crc, `${name}: the CRC in the header is the body's`)
    out.set(name, Buffer.from(body))
    at += 30 + nameLength + extra + size
  }
  assert.equal(zip.readUInt32LE(at), 0x02014b50, 'the central directory follows the last file')
  return out
}

async function download(path: string, cookie: string): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const res = await call(app.base, 'GET', path, { cookie })
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers }
}

/** The hidden test's downloads in the audit log, newest first. */
function hiddenDownloads(): AdminAuditEvent[] {
  return listAdminEvents({ limit: 200 }).events.filter((event) => event.action === 'competition.hidden_test_downloaded')
}

test('the archive holds every kind of material, laid out for a colleague, and nothing else', async () => {
  const res = await download(`/api/admin/competitions/${full.id}/materials.zip`, colleague.cookie)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/zip')
  assert.match(res.headers.get('content-disposition') ?? '', /filename="materials-full-materials\.zip"; filename\*=UTF-8''materials-full-materials\.zip/)
  assert.equal(Number(res.headers.get('content-length')), res.body.length, 'the length promised is the length sent')
  const files = entries(res.body)
  const top = materialsTop(full)
  assert.equal(top, 'materials-full-materials')
  assert.deepEqual([...files.keys()].sort(), [
    'README.md', 'competition.json', 'data/test.csv', 'data/train.csv', 'environment/packages.txt',
    'hidden/test.csv', 'metric/metric.py', 'solution/notebook.ipynb', 'task.md',
  ].map((name) => `${top}/${name}`))
  const text = (name: string) => files.get(`${top}/${name}`)!.toString('utf8')
  assert.equal(text('task.md'), DESCRIPTION, 'the task word for word, as the editor holds it')
  assert.equal(text('metric/metric.py'), METRIC)
  assert.equal(text('data/train.csv'), TRAIN)
  assert.equal(text('data/test.csv'), EXAMPLE, 'the open example in data/')
  assert.equal(text('hidden/test.csv'), HIDDEN, 'the hidden test of the same name in hidden/')
  assert.equal(text('solution/notebook.ipynb'), BASELINE)
  assert.equal(text('environment/packages.txt'), '# base · Python 3.11.16 · linux/amd64\nnumpy==2.4.6\npandas==2.3.3\n')
  assert.match(text('README.md'), /^# Материалы materials-full\n/)
  assert.match(text('README.md'), /\/k\/materials-full/)
  assert.match(text('README.md'), /Курс с материалами/)
  assert.match(text('README.md'), /solution\.csv/, 'the README says the answers are left out')

  const settings = JSON.parse(text('competition.json')) as Record<string, any>
  assert.equal(settings.title, full.title)
  assert.equal(settings.course, 'Курс с материалами')
  assert.deepEqual(settings.limits, { wallSeconds: 900, memoryMb: 2048, cpus: 2, perDay: 3, gpu: false })
  assert.deepEqual(settings.metric, { name: 'RMSE', direction: 'lower', file: 'metric/metric.py' })
  assert.deepEqual(settings.base, { environment: 'base', python: '3.11.16', platform: 'linux/amd64', packages: 'environment/packages.txt' })
  assert.deepEqual(settings.files.data.map((file: { name: string }) => file.name).sort(), ['test.csv', 'train.csv'])
  assert.deepEqual(settings.files.hidden, [{ name: 'test.csv', bytes: HIDDEN.length, rows: 1, replaces: 'test.csv' }])
  // The answers by what the editor shows of them: never their bytes.
  assert.deepEqual(settings.files.answers, [{ name: 'solution.csv', rows: 1, columns: ['id', 'y'], included: false }])
  assert.equal(settings.files.solution.file, 'solution/notebook.ipynb')

  const everything = res.body.toString('latin1') + res.body.toString('utf8')
  assert.doesNotMatch(everything, /ANSWER-ROW/, 'the answers ride out')
  for (const secret of [full.splitSeed, entrantKey, entrantName, submissionId]) {
    assert.ok(!everything.includes(secret), `the archive carries ${secret}`)
  }
})

test('competition.json is written field by field: a field added to the row never rides out by itself', () => {
  const input: MaterialsInput = {
    competition: { ...full, ...({ secretOfTomorrow: 'leak' } as object) } as Competition,
    openFiles: [], hiddenFiles: [], sealedFiles: [], split: null, baseline: null, course: null, revision: null,
    dependencies: { enabled: false, maxDownloadBytes: 1 },
  }
  const settings = materialsSettings(input)
  assert.deepEqual(Object.keys(settings).sort(), [
    'base', 'blurb', 'boardVisibility', 'course', 'deadlineAt', 'dependencies', 'environment', 'files', 'lateSubmissions',
    'limits', 'metric', 'outputPolicy', 'page', 'privateRelease', 'publicPercent', 'scoring', 'slug', 'split', 'startsAt', 'state', 'title',
  ])
  const text = JSON.stringify(settings)
  for (const leak of ['leak', full.splitSeed, full.id, author.teacher.id, METRIC]) assert.ok(!text.includes(leak), `competition.json carries ${leak}`)
})

test('the hidden test leaves only with a row in the audit log: who, when, which file, by which door', async () => {
  const before = hiddenDownloads().length
  const one = await download(`/api/admin/competitions/${full.id}/sealed/test.csv`, colleague.cookie)
  assert.equal(one.status, 200)
  assert.equal(one.body.toString('utf8'), HIDDEN)
  assert.match(one.headers.get('content-disposition') ?? '', /^attachment; filename="test\.csv"/)
  const archive = await download(`/api/admin/competitions/${full.id}/materials.zip`, author.cookie)
  assert.equal(archive.status, 200)
  const rows = hiddenDownloads()
  assert.equal(rows.length, before + 2)
  const [byArchive, byFile] = rows
  assert.equal(byFile.actor?.id, colleague.teacher.id)
  assert.deepEqual(byFile.target, { type: 'competition', id: full.id, label: full.title })
  assert.deepEqual(byFile.detail, { files: ['test.csv'], via: 'file' })
  assert.equal(byArchive.actor?.id, author.teacher.id)
  assert.deepEqual(byArchive.detail, { files: ['test.csv'], via: 'archive' })
  assert.ok(Date.now() - byArchive.at < 60_000, 'the row says when')

  // Without a hidden test there is nothing to record.
  const quiet = await download(`/api/admin/competitions/${plain.id}/materials.zip`, author.cookie)
  assert.equal(quiet.status, 200)
  const plainFiles = [...entries(quiet.body).keys()].map((name) => name.slice(`${materialsTop(plain)}/`.length)).sort()
  assert.deepEqual(plainFiles, ['README.md', 'competition.json', 'data/test.csv', 'data/train.csv', 'metric/metric.py', 'task.md'])
  assert.equal(hiddenDownloads().length, before + 2)
})

test('a teacher\'s download is kept in no cache, and only a GET takes the hidden test', async () => {
  const before = hiddenDownloads().length
  const sealedPath = `/api/admin/competitions/${full.id}/sealed/test.csv`
  const zipPath = `/api/admin/competitions/${full.id}/materials.zip`
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${app.base}${path}`, { headers: { cookie: colleague.cookie, ...headers } })
  // A HEAD — a download manager's, a link checker's — is the headers a GET would have: no bytes, no archive built, no row.
  for (const path of [sealedPath, zipPath]) {
    const head = await fetch(`${app.base}${path}`, { method: 'HEAD', headers: { cookie: colleague.cookie } })
    assert.equal(head.status, 200, path)
    assert.equal(head.headers.get('cache-control'), 'private, no-store', path)
    assert.equal((await head.arrayBuffer()).byteLength, 0, path)
  }
  const zipHead = await fetch(`${app.base}${zipPath}`, { method: 'HEAD', headers: { cookie: colleague.cookie } })
  assert.equal(zipHead.headers.get('content-type'), 'application/zip')
  assert.match(zipHead.headers.get('content-disposition') ?? '', /filename="materials-full-materials\.zip"/)
  assert.equal(hiddenDownloads().length, before, 'a HEAD is no download')

  // Its own door: nothing for a cache to keep, nothing to revalidate against — a GET always sends the file, and says so.
  const first = await get(sealedPath)
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('cache-control'), 'private, no-store')
  assert.equal(first.headers.get('etag'), null)
  assert.equal(first.headers.get('last-modified'), null)
  assert.equal(await first.text(), HIDDEN)
  const revalidated = await get(sealedPath, { 'if-none-match': 'W/"15-a"', 'if-modified-since': new Date(Date.now() + 86_400_000).toUTCString() })
  assert.equal(revalidated.status, 200, 'no validator, no 304: the bytes go out again')
  assert.equal(await revalidated.text(), HIDDEN)
  // A byte range sends bytes too: from the second byte on is the whole file but one, and it is a row like any GET.
  const range = await get(sealedPath, { range: 'bytes=1-' })
  assert.equal(range.status, 206)
  assert.equal(await range.text(), HIDDEN.slice(1))
  assert.equal(hiddenDownloads().length, before + 3)

  // The archive carries the hidden test too: the same answer as its own door, a GET of it a row like any.
  const archive = await get(zipPath)
  assert.equal(archive.status, 200)
  assert.equal(archive.headers.get('cache-control'), 'private, no-store')
  assert.equal(archive.headers.get('etag'), null)
  assert.ok(entries(Buffer.from(await archive.arrayBuffer())).has(`${materialsTop(full)}/hidden/test.csv`))
  assert.equal(hiddenDownloads().length, before + 4)

  // The open data and the sample notebook through the teacher's doors: kept nowhere either.
  for (const path of [`/api/admin/competitions/${full.id}/files/train.csv`, `/api/admin/competitions/${full.id}/baseline`]) {
    const res = await get(path)
    assert.equal(res.status, 200, path)
    assert.equal(res.headers.get('cache-control'), 'private, no-store', path)
    assert.equal(res.headers.get('etag'), null, path)
    await res.arrayBuffer()
  }
})

test('a teacher outside the competition is refused at every door, the way a missing one is', async () => {
  const before = hiddenDownloads().length
  for (const path of [
    `/api/admin/competitions/${full.id}/materials.zip`,
    `/api/admin/competitions/${full.id}/files/train.csv`,
    `/api/admin/competitions/${full.id}/sealed/test.csv`,
    `/api/admin/competitions/${full.id}/baseline`,
  ]) {
    const refused = await download(path, stranger.cookie)
    assert.equal(refused.status, 404, path)
    assert.equal(JSON.parse(refused.body.toString('utf8')).reason, 'not_found', path)
    assert.ok(!refused.body.toString('utf8').includes('HIDDEN-ROW'))
  }
  assert.equal((await download(`/api/admin/competitions/${full.id}/materials.zip`, '')).status, 401)
  assert.equal(hiddenDownloads().length, before, 'a refusal is no download')
  // An owner sees every competition.
  assert.equal((await download(`/api/admin/competitions/${full.id}/materials.zip`, owner.cookie)).status, 200)
})

test('each file at its own door: listed by its row, streamed whole, the answers at none', async () => {
  const train = await download(`/api/admin/competitions/${full.id}/files/train.csv`, colleague.cookie)
  assert.equal(train.status, 200)
  assert.equal(train.body.toString('utf8'), TRAIN)
  assert.match(train.headers.get('content-disposition') ?? '', /^attachment; filename="train\.csv"/)
  // A byte range, as the entrant's own door serves one: a big table resumes.
  const range = await fetch(`${app.base}/api/admin/competitions/${full.id}/files/train.csv`, { headers: { cookie: colleague.cookie, range: 'bytes=0-5' } })
  assert.equal(range.status, 206)
  assert.equal(await range.text(), TRAIN.slice(0, 6))
  const baseline = await download(`/api/admin/competitions/${full.id}/baseline`, colleague.cookie)
  assert.equal(baseline.status, 200)
  assert.equal(baseline.body.toString('utf8'), BASELINE)
  assert.match(baseline.headers.get('content-disposition') ?? '', /filename="materials-full-baseline\.ipynb"/)
  assert.equal((await download(`/api/admin/competitions/${plain.id}/baseline`, author.cookie)).status, 404, 'no sample notebook, no file')
  // The answers have no door: not as open data, not as the hidden test.
  for (const path of [`/api/admin/competitions/${full.id}/files/solution.csv`, `/api/admin/competitions/${full.id}/sealed/solution.csv`]) {
    const refused = await download(path, owner.cookie)
    assert.equal(refused.status, 404, path)
    assert.doesNotMatch(refused.body.toString('utf8'), /ANSWER-ROW/)
  }
  // A hidden test by a name of its own is not open data.
  assert.equal((await download(`/api/admin/competitions/${plain.id}/sealed/test.csv`, author.cookie)).status, 404)
})
