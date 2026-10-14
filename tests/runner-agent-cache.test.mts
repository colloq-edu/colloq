/**
 * The machine's content-addressed cache (server/src/runner-agent/cache.ts):
 * what home hands out by hash, checked on arrival, resumed when cut short,
 * linked into the folders a run mounts, the hidden test kept apart and
 * purged, and evicted least recently used first when the disk runs low.
 *
 * Each rule fails quietly where it matters. A blob that took its name before
 * its hash was checked is a notebook scored on the wrong data; a resume that
 * appended to the wrong offset, the same; a hidden test left behind by a
 * purge is the answer key's inputs on a rented VM that is no longer trusted;
 * an eviction that took a file a run mounts empties its /data mid-run.
 */
import './_env.mts'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { remoteManifest, type RemoteWantBundle } from '../shared/remote-runner.ts'
import { Cache } from '../server/src/runner-agent/cache.ts'
import { RemoteClient, Backoff } from '../server/src/runner-agent/client.ts'
import { competitionsDir } from '../server/src/competitions/storage.ts'
import { bundleDir } from '../server/src/dependencies/files.ts'
import { TEST_ROOT } from './_env.mts'
import { dataSet, fakeHome, hex, makeLease, serveBlob, sha256, waitFor, type FakeHome } from './_runner-agent-home.mts'

const BOOKS = path.join(TEST_ROOT, 'books')

beforeEach(() => {
  fs.rmSync(path.join(TEST_ROOT, 'data'), { recursive: true, force: true })
  fs.rmSync(BOOKS, { recursive: true, force: true })
})

function cacheFor(home: FakeHome, extra: Partial<ConstructorParameters<typeof Cache>[0]> = {}): Cache {
  const client = new RemoteClient({ home: home.url, build: 'dev', credential: () => null })
  const cache = new Cache({ client, books: BOOKS, backoff: new Backoff(() => 0, 5, 20), idleMs: 2_000, log: () => undefined, ...extra })
  cache.load()
  return cache
}

const blobsDir = (): string => path.join(competitionsDir, '.blobs')
const sealedDir = (): string => path.join(competitionsDir, '.sealed')

test('a blob is checked on arrival: bytes that do not hash to their name never take it, and the manifest says why', async () => {
  const home = await fakeHome()
  const cache = cacheFor(home)
  try {
    const set = dataSet({ 'train.csv': 'id,x\n1,2\n' })
    const [file] = set.files
    // Home (or whatever is between) serves other bytes of the same length under the hash.
    home.blobs.set(file!.sha256, Buffer.from('id,x\n9,9\n'))
    cache.want([{ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files }], [])
    await waitFor(() => cache.problemList().length > 0, 'the data problem')
    assert.deepEqual(cache.readyData(), [])
    assert.ok(!fs.existsSync(path.join(blobsDir(), file!.sha256)), 'a blob that failed its hash took its name')
    assert.deepEqual(fs.readdirSync(blobsDir()).filter((name) => name.endsWith('.part')), [], 'its bytes stayed behind')
    const [problem] = cache.problemList()
    assert.equal(problem!.code, 'data')
    assert.equal(problem!.manifest, set.manifest)
    assert.match(problem!.detail, /not what was asked/)
  } finally {
    cache.stop()
    await home.close()
  }
})

test('a download cut short resumes with a Range from where it stopped; a home that sends it all again is started over', async () => {
  const home = await fakeHome()
  const cache = cacheFor(home)
  try {
    const body = Buffer.from('a'.repeat(1000) + 'b'.repeat(1000))
    const sha = sha256(body)
    home.blobs.set(sha, body)
    fs.mkdirSync(blobsDir(), { recursive: true })
    // The first half from an earlier life, as a partial file beside its name.
    fs.writeFileSync(path.join(blobsDir(), `.${sha}.part`), body.subarray(0, 1000))
    const file = await cache.blob(sha, body.length)
    assert.equal(fs.readFileSync(file).toString(), body.toString())
    const ranges = home.calls.filter((call) => call.path.endsWith(sha)).map((call) => call.headers.range)
    assert.deepEqual(ranges, ['bytes=1000-'])

    // A home that ignores the range and sends the whole blob: the partial file is not appended to.
    const other = Buffer.from('c'.repeat(3000))
    const otherSha = sha256(other)
    home.onBlob = () => ({ status: 200, body: other })
    fs.writeFileSync(path.join(blobsDir(), `.${otherSha}.part`), other.subarray(0, 1200))
    const whole = await cache.blob(otherSha, other.length)
    assert.equal(sha256(fs.readFileSync(whole)), otherSha)

    // A partial file a crash left whole before its rename is checked and named without a request.
    home.onBlob = null
    const third = Buffer.from('third blob')
    const thirdSha = sha256(third)
    fs.writeFileSync(path.join(blobsDir(), `.${thirdSha}.part`), third)
    const before = home.calls.length
    assert.equal(fs.readFileSync(await cache.blob(thirdSha, third.length)).toString(), 'third blob')
    assert.equal(home.calls.length, before)

    // A partial file that is no prefix of the blob: past its end home answers 416, and it starts over.
    const fourth = Buffer.from('four')
    const fourthSha = sha256(fourth)
    fs.writeFileSync(path.join(blobsDir(), `.${fourthSha}.part`), Buffer.from('xx'))
    home.onBlob = ({ range }) => (range ? { status: 416, json: { error: 'invalid', detail: 'range' } } : serveBlob(fourth, undefined))
    assert.equal(fs.readFileSync(await cache.blob(fourthSha, fourth.length)).toString(), 'four')

    // Within its length: the rest comes, the whole fails its hash, and the blob is fetched again from its start, at once.
    home.onBlob = null
    const fifth = Buffer.from('fifth blob body')
    const fifthSha = sha256(fifth)
    home.blobs.set(fifthSha, fifth)
    fs.writeFileSync(path.join(blobsDir(), `.${fifthSha}.part`), Buffer.from('JUNK!'))
    assert.equal(fs.readFileSync(await cache.blob(fifthSha, fifth.length)).toString(), 'fifth blob body')
    assert.deepEqual(home.calls.filter((call) => call.path.endsWith(fifthSha)).map((call) => call.headers.range ?? 'all'), ['bytes=5-', 'all'])
  } finally {
    cache.stop()
    await home.close()
  }
})

test('a lease\'s blob goes ahead of the prefetch under way, which keeps its bytes and resumes with a Range after', async () => {
  const home = await fakeHome()
  const cache = cacheFor(home)
  try {
    const big = Buffer.from('x'.repeat(4000))
    const set = { files: [{ name: 'big.csv', sha256: sha256(big), bytes: big.length }] }
    const notebook = Buffer.from('{"cells":[]}')
    home.blobs.set(sha256(notebook), notebook)
    let firstStream = true
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    home.onBlob = ({ sha, range }) => {
      if (sha !== set.files[0]!.sha256) return serveBlob(home.blobs.get(sha), range)
      if (firstStream) {
        firstStream = false
        // A slow link: half of it, then nothing until the test says so.
        return { status: 200, slow: { pieces: [big.subarray(0, 2000)], gapMs: 5, until: held }, headers: { 'Content-Type': 'application/octet-stream' } }
      }
      return serveBlob(big, range)
    }
    cache.want([{ competitionId: 'compabcd', manifest: remoteManifest(set.files, sha256), sealed: false, files: set.files }], [])
    const part = path.join(blobsDir(), `.${set.files[0]!.sha256}.part`)
    await waitFor(() => fs.existsSync(part) && fs.statSync(part).size === 2000, 'the prefetch under way')
    // The lease's notebook: the prefetch is stopped and the notebook goes first.
    const file = await cache.blob(sha256(notebook), notebook.length)
    assert.equal(fs.readFileSync(file).toString(), notebook.toString())
    release()
    await waitFor(() => cache.readyData().length === 1, 'the prefetch resumed and done')
    const asks = home.calls.filter((call) => call.path.endsWith(set.files[0]!.sha256)).map((call) => call.headers.range ?? 'all')
    assert.deepEqual(asks, ['all', 'bytes=2000-'])
    assert.equal(sha256(fs.readFileSync(path.join(blobsDir(), set.files[0]!.sha256))), set.files[0]!.sha256)
  } finally {
    cache.stop()
    await home.close()
  }
})

test('a data manifest is a folder of hard links to its blobs, exactly its files; one tampered with is rebuilt', async () => {
  const home = await fakeHome()
  const cache = cacheFor(home)
  try {
    const set = dataSet({ 'train.csv': 'id,x\n1,2\n', 'test.csv': 'id\n1\n' })
    for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
    cache.want([{ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files }], [])
    await waitFor(() => cache.readyData().includes(set.manifest), 'the manifest complete')
    const dir = cache.dataDir(set.manifest)
    assert.equal(dir, path.join(competitionsDir, 'compabcd', 'inputs', set.manifest.slice(0, 12)))
    assert.deepEqual(fs.readdirSync(dir).sort(), ['test.csv', 'train.csv'])
    for (const file of set.files) {
      const linked = fs.statSync(path.join(dir, file.name))
      assert.equal(linked.ino, fs.statSync(path.join(blobsDir(), file.sha256)).ino, `${file.name} is a copy, not a link`)
    }
    // Something else got in: rebuilt, with the manifest's names only.
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'x')
    const mountedIno = fs.statSync(path.join(dir, 'train.csv')).ino
    const again = cache.dataDir(set.manifest)
    assert.deepEqual(fs.readdirSync(again).sort(), ['test.csv', 'train.csv'])
    // The folder a run may have mounted was moved aside whole, never emptied under it.
    const inputs = path.dirname(again)
    const aside = fs.readdirSync(inputs).filter((name) => name.includes('.old-'))
    assert.equal(aside.length, 1)
    assert.equal(fs.statSync(path.join(inputs, aside[0]!, 'train.csv')).ino, mountedIno)
    assert.ok(fs.existsSync(path.join(inputs, aside[0]!, 'stray.txt')))
    // The next start removes it: no container of the earlier life is left by then.
    cacheFor(home).stop()
    assert.deepEqual(fs.readdirSync(inputs).filter((name) => name.startsWith('.')), [])
    // A manifest whose files do not hash to its name is a problem, and nothing of it is fetched.
    const before = home.calls.length
    cache.want([{ competitionId: 'compabcd', manifest: 'f'.repeat(64), sealed: false, files: set.files }], [])
    assert.equal(cache.problemList()[0]?.code, 'data')
    await cache.idle()
    assert.equal(home.calls.length, before)
  } finally {
    cache.stop()
    await home.close()
  }
})

test('the hidden test lives apart and goes when purged, while a run that holds its links keeps their bytes', async () => {
  const home = await fakeHome()
  const cache = cacheFor(home)
  try {
    const open = dataSet({ 'train.csv': 'id,y\n1,0\n', 'test.csv': 'id\n1\n' })
    const hidden = dataSet({ 'test.csv': 'id\n7\n8\n' })
    for (const [sha, body] of [...open.bodies, ...hidden.bodies]) home.blobs.set(sha, body)
    cache.want([
      { competitionId: 'compabcd', manifest: open.manifest, sealed: false, files: open.files },
      { competitionId: 'compabcd', manifest: hidden.manifest, sealed: true, files: hidden.files },
    ], [])
    await waitFor(() => cache.readySealed().includes(hidden.manifest) && cache.readyData().includes(open.manifest), 'both manifests')
    assert.ok(fs.existsSync(path.join(sealedDir(), hidden.files[0]!.sha256)))
    assert.ok(!fs.existsSync(path.join(blobsDir(), hidden.files[0]!.sha256)), 'the hidden test sits with the open data')
    // A hidden-test run's own /data: the open files with the hidden one over them, by name.
    const lease = makeLease({ data: open.manifest, sealed: true, sealedData: hidden.manifest })
    const dir = cache.composeSealed(lease)
    assert.equal(fs.readFileSync(path.join(dir, 'test.csv'), 'utf8'), 'id\n7\n8\n')
    assert.equal(fs.readFileSync(path.join(dir, 'train.csv'), 'utf8'), 'id,y\n1,0\n')
    assert.ok(cache.holdsSealed())
    cache.purgeSealed('untrusted')
    assert.deepEqual(fs.readdirSync(sealedDir()), [])
    assert.deepEqual(cache.readySealed(), [])
    assert.ok(!cache.holdsSealed())
    // The run's link keeps the bytes it started with; the open data is untouched.
    assert.equal(fs.readFileSync(path.join(dir, 'test.csv'), 'utf8'), 'id\n7\n8\n')
    assert.deepEqual(cache.readyData(), [open.manifest])
    // A hidden test no longer wanted, and held by no lease, goes at once.
    cache.want([{ competitionId: 'compabcd', manifest: hidden.manifest, sealed: true, files: hidden.files }], [])
    await waitFor(() => cache.readySealed().length === 1, 'the hidden test again')
    cache.want([], [])
    assert.deepEqual(fs.readdirSync(sealedDir()), [])
  } finally {
    cache.stop()
    await home.close()
  }
})

test('below the disk\'s floor, what nobody wants or holds goes, least recently used first, until the floor holds', async () => {
  const home = await fakeHome()
  const cache = cacheFor(home)
  try {
    const sets = ['one', 'two', 'three'].map((name) => dataSet({ [`${name}.csv`]: `${name}\n`.repeat(10) }))
    for (const set of sets) for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
    cache.want(sets.map((set) => ({ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files })), [])
    await waitFor(() => cache.readyData().length === 3, 'three manifests')
    // Their last use: two the oldest, one in between, three the newest.
    const at = (set: (typeof sets)[number], seconds: number): void => {
      const when = new Date(Date.now() - seconds * 1000)
      fs.utimesSync(path.join(blobsDir(), set.files[0]!.sha256), when, when)
    }
    at(sets[1]!, 300)
    at(sets[0]!, 200)
    at(sets[2]!, 100)
    // Home wants none of them any more; the third is held by a lease.
    cache.want([], [])
    let free = 0
    const keep = { manifests: new Set([sets[2]!.manifest]), bundles: new Set<string>(), blobs: new Set([sets[2]!.files[0]!.sha256]) }
    // Each removal frees a megabyte, as far as this test's disk is concerned; the floor wants one more than there is.
    const removedBefore = (): number => sets.filter((set) => !fs.existsSync(path.join(blobsDir(), set.files[0]!.sha256))).length
    assert.equal(cache.evict(keep, () => free + removedBefore(), 1), true)
    assert.ok(!fs.existsSync(path.join(blobsDir(), sets[1]!.files[0]!.sha256)), 'the least recently used went first')
    assert.ok(fs.existsSync(path.join(blobsDir(), sets[0]!.files[0]!.sha256)), 'more went than the floor wanted')
    // Nothing more can go but what is kept: the floor cannot hold.
    assert.equal(cache.evict(keep, () => 0, 10), false)
    assert.ok(fs.existsSync(path.join(blobsDir(), sets[2]!.files[0]!.sha256)), 'a blob a lease holds was evicted')
    free = 100
    assert.equal(cache.evict(keep, () => free, 10), true)
  } finally {
    cache.stop()
    await home.close()
  }
})

test('wheels come from the index by their URL and are checked; a wrong one, or none, comes from home by its hash; the set is installed where the harness reads it', async () => {
  const home = await fakeHome()
  const good = Buffer.from('wheel-one-bytes')
  const bad = Buffer.from('wheel-two-bytes')
  const forged = Buffer.from('wheel-two-BYTES')
  const third = Buffer.from('wheel-three')
  const asked: string[] = []
  const index: typeof fetch = async (input, init) => {
    const url = String(input)
    if (!url.startsWith('https://files.example/')) return fetch(input, init)
    asked.push(url)
    assert.equal(new Headers(init?.headers).get('authorization'), null, 'a credential went to the index')
    if (url.endsWith('one-1.0-py3-none-any.whl')) return new Response(good)
    if (url.endsWith('two-1.0-py3-none-any.whl')) return new Response(forged)
    return new Response('no', { status: 404 })
  }
  const cache = cacheFor(home, { fetch: index })
  try {
    home.blobs.set(sha256(bad), bad)
    home.blobs.set(sha256(third), third)
    const id = hex(16)
    const bundle: RemoteWantBundle = {
      id,
      packagesMb: 64,
      lock: 'one==1.0 --hash=sha256:aa\ntwo==1.0 --hash=sha256:bb\nthree==1.0 --hash=sha256:cc\n',
      wheels: [
        { fileName: 'one-1.0-py3-none-any.whl', sha256: sha256(good), bytes: good.length, url: 'https://files.example/packages/one-1.0-py3-none-any.whl' },
        { fileName: 'two-1.0-py3-none-any.whl', sha256: sha256(bad), bytes: bad.length, url: 'https://files.example/packages/two-1.0-py3-none-any.whl' },
        { fileName: 'three-1.0-py3-none-any.whl', sha256: sha256(third), bytes: third.length },
      ],
    }
    cache.want([], [bundle])
    await waitFor(() => cache.readyBundles().includes(id), 'the set installed')
    const dir = bundleDir(id)
    assert.equal(fs.readFileSync(path.join(dir, 'requirements.lock'), 'utf8'), bundle.lock)
    assert.equal(fs.readFileSync(path.join(dir, 'wheels', 'one-1.0-py3-none-any.whl')).toString(), good.toString())
    // The index's wheel was not the pinned one: home's, by its hash.
    assert.equal(fs.readFileSync(path.join(dir, 'wheels', 'two-1.0-py3-none-any.whl')).toString(), bad.toString())
    assert.equal(fs.readFileSync(path.join(dir, 'wheels', 'three-1.0-py3-none-any.whl')).toString(), third.toString())
    assert.deepEqual(asked.map((url) => url.split('/').pop()), ['one-1.0-py3-none-any.whl', 'two-1.0-py3-none-any.whl'])
    const fromHome = home.calls.filter((call) => call.path.includes('/blobs/')).map((call) => call.path.split('/').pop())
    assert.deepEqual(fromHome.sort(), [sha256(bad), sha256(third)].sort())
    // A lease's set, asked again, is the folder in place.
    assert.equal(await cache.bundle(id), dir)
    // A set home has not described yet is not one the cache can install.
    assert.equal(await cache.bundle(hex(16)), null)
  } finally {
    cache.stop()
    await home.close()
  }
})

test('the notebook rides inside the lease or comes by its hash, and is checked either way', async () => {
  const home = await fakeHome()
  const cache = cacheFor(home)
  try {
    const lease = makeLease({ data: 'f'.repeat(64) })
    const dir = await cache.placeNotebook(lease)
    assert.equal(dir, path.join(competitionsDir, 'compabcd', 's', 'subabcde', 'in'))
    assert.deepEqual(fs.readdirSync(dir), ['notebook.ipynb'])
    const big = Buffer.from(JSON.stringify({ cells: [], padding: 'x'.repeat(70_000) }))
    home.blobs.set(sha256(big), big)
    const byHash = makeLease({ data: 'f'.repeat(64), submissionId: 'subbbbbb', notebook: { sha256: sha256(big), bytes: big.length } })
    const other = await cache.placeNotebook(byHash)
    assert.equal(fs.readFileSync(path.join(other, 'notebook.ipynb')).length, big.length)
    // An inline notebook that is not the one the lease names is refused.
    const forged = makeLease({ data: 'f'.repeat(64), submissionId: 'subccccc' })
    forged.notebook = { ...forged.notebook, sha256: 'e'.repeat(64) }
    await assert.rejects(cache.placeNotebook(forged), /not the one it names/)
  } finally {
    cache.stop()
    await home.close()
  }
})
