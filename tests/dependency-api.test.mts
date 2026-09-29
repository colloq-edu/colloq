import './_env.mts'
import http from 'node:http'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { app } from '../server/src/app.js'
import { issueEntrantCookie } from '../server/src/competitions/identity.js'
import { createCompetition, createEntrant, getCompetition, setCompetitionState, joinCompetition, listEntrantSubmissions, updateCompetition } from '../server/src/competitions/store.js'
import { putRevision, selectRevision, setPolicy, createBundle, completeBundle, cancelBundle, failBundle, getBinding, listBundles } from '../server/src/dependencies/store.js'
import { cancelPreparation, prepareBundle } from '../server/src/dependencies/service.js'

let server: http.Server, origin = '', sequence = 0
before(async () => {
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  origin = `http://127.0.0.1:${address.port}`
})
after(() => { server.closeAllConnections(); server.close() })

function person() {
  const e = createEntrant(`Dependency API ${++sequence}`).entrant
  let cookie = ''
  issueEntrantCookie({ cookie(name: string, value: string) { cookie = `${name}=${value}` } } as ExpressResponse, e)
  return { ...e, cookie }
}
function fixture() {
  const c = createCompetition({ slug: `dependency-api-${++sequence}`, title: 'Dependency API', environment: 'base' })!
  setCompetitionState(c.id, 'live')
  const r = putRevision({ environmentName: 'base', imageDigest: `sha256:${'a'.repeat(64)}`, pythonVersion: '3.11.16', pythonAbi: 'cp311', platform: 'linux/arm64', packages: [{ name: 'numpy', version: '2.4.6' }], baseConstraintsHash: 'hash' })
  selectRevision(c.id, r.id); setPolicy(c.id, { enabled: true })
  const owner = person(), other = person()
  joinCompetition(c.id, owner.id, owner.name); joinCompetition(c.id, other.id, other.name)
  return { c: getCompetition(c.id)!, r, owner, other, base: `/api/k/competitions/${c.slug}/dependencies` }
}
const result = { normalizedRequirements: ['example==1'], packages: [], downloadBytes: 0, installedBytes: 0, contentHash: '0'.repeat(64), lock: '# immutable test lock\n' }
function call(url: string, cookie?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (cookie) headers.set('cookie', cookie)
  if (typeof init.body === 'string') headers.set('content-type', 'application/json')
  return fetch(origin + url, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(5000) })
}
function upload(url: string, cookie: string, bundleId: string) {
  const form = new FormData()
  // One cell: a notebook without any is refused at the door, before the bundle
  // checks this suite is about (@shared/competitions · whyNotebookRefused).
  const cell = { cell_type: 'code', source: 'import example', metadata: {}, outputs: [], execution_count: null }
  form.append('file', new Blob([JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [cell] })]), 'model.ipynb')
  form.append('bundleId', bundleId)
  return call(url, cookie, { method: 'POST', body: form })
}

test('dependency status, lock, stream, cancellation and admin routes enforce identity and ownership', async () => {
  const { c, r, owner, other, base } = fixture()
  const b = createBundle(c.id, owner.id, r.id, 'example')
  completeBundle(b.id, result)
  assert.equal((await call(base)).status, 401)
  for (const suffix of ['', '/lock', '/stream', '/cancel']) {
    const response = await call(`${base}/${b.id}${suffix}`, other.cookie, suffix === '/cancel' ? { method: 'POST' } : {})
    assert.equal(response.status, 404, suffix)
    assert.equal((await response.json()).reason, 'dependency_owner')
  }
  const overview = await (await call(base, other.cookie)).json()
  assert.deepEqual(overview.bundles, [])
  assert.equal((await call(`${base}/${b.id}/lock`, owner.cookie)).status, 200)
  assert.equal((await call(`/api/admin/competitions/${c.id}/dependencies`, owner.cookie)).status, 401)
  const crossOrigin = await call(base + '/draft', owner.cookie, {
    method: 'PUT', headers: { origin: 'https://untrusted.example' },
    body: JSON.stringify({ requirementsText: 'example', selectedBundleId: b.id }),
  })
  assert.equal(crossOrigin.status, 403)
})

test('preparation requires joining and rejects a competition closed during its async setup', async () => {
  const { c, owner, base } = fixture(), outsider = person()
  const denied = await call(base + '/prepare', outsider.cookie, { method: 'POST', body: JSON.stringify({ requirementsText: 'example' }) })
  assert.equal(denied.status, 403)
  assert.equal((await denied.json()).reason, 'dependency_join')
  const pending = prepareBundle(c, owner.id, 'example')
  setCompetitionState(c.id, 'finished')
  await assert.rejects(pending, { code: 'dependency_closed' })
})

test('the Packages tab hears the hour\'s preparations before the refusal, and the refusal says when', async () => {
  const { c, r, owner, base } = fixture()
  const overview = await (await call(base, owner.cookie)).json()
  assert.deepEqual(overview.quota, { left: 10, nextAt: null })
  const prepared = await call(base + '/prepare', owner.cookie, { method: 'POST', body: JSON.stringify({ requirementsText: 'example' }) })
  assert.equal(prepared.status, 202)
  const { bundle, quota } = await prepared.json()
  assert.deepEqual(quota, { left: 9, nextAt: null }, 'the answer carries the hour after this preparation')
  cancelBundle(bundle.id)
  for (let i = 1; i < 10; i++) cancelBundle(createBundle(c.id, owner.id, r.id, `example${i}`).id)
  const spent = (await (await call(base, owner.cookie)).json()).quota
  assert.equal(spent.left, 0)
  assert.ok(spent.nextAt > Date.now() + 59 * 60000 && spent.nextAt <= Date.now() + 60 * 60000, String(spent.nextAt))
  const refused = await call(base + '/prepare', owner.cookie, { method: 'POST', body: JSON.stringify({ requirementsText: 'eleventh' }) })
  assert.equal(refused.status, 429)
  const body = await refused.json()
  assert.equal(body.reason, 'dependency_quota')
  assert.equal(body.error, 'Достигнут лимит: 10 подготовок в час. Следующая подготовка — через 60 мин.')
})

test('a pip option or a URL is refused at once with its line, and no preparation is spent on it', async () => {
  const { c, owner, base } = fixture()
  for (const [text, line] of [
    ['numpy\ngit+https://github.com/tinygrad/tinygrad.git', 2],
    ['# pinned by pip-compile\nnumpy==1.26.4 --hash=sha256:' + 'a'.repeat(64), 2],
    ['torch --index-url https://download.pytorch.org/whl/cpu', 1],
    ['file:///home/student/pkg-1.0-py3-none-any.whl', 1],
  ] as const) {
    const refused = await call(base + '/prepare', owner.cookie, { method: 'POST', body: JSON.stringify({ requirementsText: text }) })
    assert.equal(refused.status, 400, text)
    const body = await refused.json()
    assert.equal(body.reason, 'unsupported_source', text)
    assert.equal(body.error, `Строка ${line}: Разрешены только имена пакетов PyPI и версии. URL, пути, хеши (--hash) и другие параметры pip не поддерживаются.`)
  }
  assert.equal(listBundles(c.id, owner.id).length, 0)
  assert.deepEqual((await (await call(base, owner.cookie)).json()).quota, { left: 10, nextAt: null })
  // Saving the draft is not preparing it: the line stays there to be fixed.
  const saved = await call(base + '/draft', owner.cookie, { method: 'PUT', body: JSON.stringify({ requirementsText: 'torch --index-url https://download.pytorch.org/whl/cpu' }) })
  assert.equal(saved.status, 200)
})

test('multipart acceptance rejects foreign, unfinished and stale bundles without creating submissions', async () => {
  const { c, r, owner, other } = fixture()
  const b = createBundle(c.id, owner.id, r.id, 'example')
  const url = `/api/k/competitions/${c.slug}/submissions`
  assert.equal((await upload(url, owner.cookie, b.id)).status, 409)
  completeBundle(b.id, result)
  assert.equal((await upload(url, other.cookie, b.id)).status, 404)
  assert.equal(listEntrantSubmissions(c.id, other.id).length, 0)
  const next = putRevision({ ...r, imageDigest: `sha256:${'b'.repeat(64)}` })
  selectRevision(c.id, next.id)
  assert.equal((await upload(url, owner.cookie, b.id)).status, 409)
  assert.equal(listEntrantSubmissions(c.id, owner.id).length, 0)
  selectRevision(c.id, r.id)
  const accepted = await upload(url, owner.cookie, b.id)
  assert.equal(accepted.status, 200)
  const body = await accepted.json()
  assert.equal(getBinding(body.submission.id)?.bundle?.id, b.id)
  assert.equal(getBinding(body.submission.id)?.revision?.id, r.id)
})

test('a set that cannot fit a submission memory is refused when it is chosen or sent, with its numbers', async () => {
  const { c, r, owner, base } = fixture()
  const MiB = 1024 * 1024
  updateCompetition(c.id, { limits: { memoryMb: 512 } })
  const b = createBundle(c.id, owner.id, r.id, 'xgboost-cpu\ncatboost\nlightgbm')
  // The set a class could not install: 315 MB unpacked, a 379 MB room with its margin.
  completeBundle(b.id, { ...result, installedBytes: 315 * MiB })
  const url = `/api/k/competitions/${c.slug}/submissions`
  const refused = await upload(url, owner.cookie, b.id)
  assert.equal(refused.status, 409)
  assert.equal((await refused.json()).error,
    'Набор пакетов не поместится в посылку: в памяти он займёт до 379 МБ, а набору можно не больше половины из 512 МБ, отведённых посылке. Уберите из набора тяжёлые пакеты или попросите преподавателя увеличить память.')
  assert.equal(listEntrantSubmissions(c.id, owner.id).length, 0, 'nothing is queued to fail inside the run')
  const chosen = await call(base + '/draft', owner.cookie, { method: 'PUT', body: JSON.stringify({ requirementsText: 'catboost', selectedBundleId: b.id }) })
  assert.equal(chosen.status, 409)
  const answer = await chosen.json()
  assert.equal(answer.reason, 'dependency_memory')
  assert.match(answer.error, /379 МБ.*512 МБ/)
  // The page is told what a submission gets, so it can say so before anyone tries.
  assert.equal((await (await call(base, owner.cookie)).json()).memoryMb, 512)
  updateCompetition(c.id, { limits: { memoryMb: 1024 } })
  assert.equal((await upload(url, owner.cookie, b.id)).status, 200, 'under half of the memory, the same set rides')
})

for (const terminal of ['ready', 'failed', 'cancelled'] as const) {
  test(`an active dependency stream delivers ${terminal} and closes`, async () => {
    const { c, r, owner, base } = fixture()
    const b = createBundle(c.id, owner.id, r.id, 'example')
    const response = await call(`${base}/${b.id}/stream`, owner.cookie)
    const reader = response.body!.getReader()
    const initial = await reader.read()
    assert.match(new TextDecoder().decode(initial.value), /"state":"queued"/)
    if (terminal === 'ready') completeBundle(b.id, result)
    if (terminal === 'failed') failBundle(b.id, 'timeout', 'Test timeout')
    await cancelPreparation(b.id)
    let text = ''
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      text += new TextDecoder().decode(part.value)
    }
    assert.match(text, new RegExp(`"state":"${terminal}"`))
    cancelBundle(b.id)
  })
}
