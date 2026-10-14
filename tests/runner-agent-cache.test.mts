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
import { Cache, CacheError } from '../server/src/runner-agent/cache.ts'
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
    const dir = cache.dataDir(set.manifest, 'compabcd')
    assert.equal(dir, path.join(competitionsDir, 'compabcd', 'inputs', set.manifest.slice(0, 12)))
    assert.deepEqual(fs.readdirSync(dir).sort(), ['test.csv', 'train.csv'])
    for (const file of set.files) {
      const linked = fs.statSync(path.join(dir, file.name))
      assert.equal(linked.ino, fs.statSync(path.join(blobsDir(), file.sha256)).ino, `${file.name} is a copy, not a link`)
    }
    // Something else got in: rebuilt, with the manifest's names only.
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'x')
    const mountedIno = fs.statSync(path.join(dir, 'train.csv')).ino
    const again = cache.dataDir(set.manifest, 'compabcd')
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

test('two fetches of one wheel from the index at once each write their own file: the set installed holds the pinned bytes, whichever is renamed first', async () => {
  const home = await fakeHome()
  // Two halves that are not zeros: a hole a truncation leaves in the first is seen in its hash.
  const body = Buffer.concat([Buffer.alloc(20_000, 0x41), Buffer.alloc(20_000, 0x42)])
  const sha = sha256(body)
  home.blobs.set(sha, body)
  let fetches = 0
  let releaseFirst!: () => void
  const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve))
  let failSecond!: () => void
  const secondHeld = new Promise<void>((resolve) => (failSecond = resolve))
  const index: typeof fetch = async () => {
    const n = ++fetches
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        if (n === 1) {
          // The prefetch: its first half, then nothing until the lease's own fetch of the wheel has opened its file.
          controller.enqueue(body.subarray(0, 20_000))
          await firstHeld
          controller.enqueue(body.subarray(20_000))
          controller.close()
        } else {
          // The lease's: nothing, and then the index drops it, which sends it to home for the wheel.
          await secondHeld
          controller.error(new Error('the index dropped the connection'))
        }
      },
    }))
  }
  const cache = cacheFor(home, { fetch: index })
  try {
    const id = hex(16)
    const wheel = { fileName: 'big-1.0-py3-none-any.whl', sha256: sha, bytes: body.length, url: 'https://files.example/packages/big-1.0-py3-none-any.whl' }
    // A reply that describes a set together with its lease: want() starts the prefetch, prepareRun the lease's fetch of the same wheel.
    cache.want([], [{ id, packagesMb: 64, lock: 'big==1.0 --hash=sha256:aa\n', wheels: [wheel] }])
    const halfway = (): boolean => fs.readdirSync(blobsDir()).some((name) => name.endsWith('.index.part') && fs.statSync(path.join(blobsDir(), name)).size === 20_000)
    await waitFor(halfway, 'the prefetch half way')
    const lease = cache.bundle(id)
    await waitFor(() => fetches === 2, 'the lease fetching the same wheel')
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseFirst()
    await waitFor(() => cache.readyBundles().includes(id), 'the set installed')
    failSecond()
    const dir = await lease
    assert.ok(dir)
    assert.equal(sha256(fs.readFileSync(path.join(dir, 'wheels', wheel.fileName))), sha, 'the set was installed with a wheel that is not its pin')
    assert.equal(sha256(fs.readFileSync(path.join(blobsDir(), sha))), sha, 'the cache holds a wheel under a hash it does not have')
    assert.deepEqual(fs.readdirSync(blobsDir()).filter((name) => name.includes('.part')), [], 'a partial file was left behind')
  } finally {
    cache.stop()
    await home.close()
  }
})

test('what an earlier life left is taken on its hashes, not its names or lengths: a blob that does not hash to its name goes, and a set whose wheel changed is not installed', async () => {
  const home = await fakeHome()
  const set = dataSet({ 'train.csv': 'id,x\n1,2\n3,4\n' })
  const [file] = set.files
  const wheelBody = Buffer.from('wheel-bytes-0123456789-abcdef')
  const wheelSha = sha256(wheelBody)
  for (const [sha, body] of [...set.bodies, [wheelSha, wheelBody] as const]) home.blobs.set(sha, body)
  const id = hex(16)
  const bundle: RemoteWantBundle = { id, packagesMb: 64, lock: 'w==1.0 --hash=sha256:aa\n', wheels: [{ fileName: 'w-1.0-py3-none-any.whl', sha256: wheelSha, bytes: wheelBody.length }] }
  const data = [{ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files }]
  const first = cacheFor(home)
  first.want(data, [bundle])
  await waitFor(() => first.readyData().includes(set.manifest) && first.readyBundles().includes(id), 'the data and the set in place')
  first.stop()
  // Between two lives the bytes change under the names, their lengths kept: the set's wheel in place (its blob is the same inode), the data's blob.
  fs.writeFileSync(path.join(bundleDir(id), 'wheels', 'w-1.0-py3-none-any.whl'), Buffer.alloc(wheelBody.length, 0x30))
  fs.writeFileSync(path.join(blobsDir(), file!.sha256), Buffer.alloc(file!.bytes, 0x30))
  const second = cacheFor(home)
  try {
    assert.deepEqual(second.readyData(), [], 'a manifest was ready with a blob that does not hash to its name')
    assert.deepEqual(second.readyBundles(), [], 'a set was ready with a wheel that is not its pin')
    assert.ok(!fs.existsSync(path.join(blobsDir(), file!.sha256)), 'a blob that does not hash to its name kept it')
    assert.ok(!fs.existsSync(path.join(blobsDir(), wheelSha)))
    // Wanted again, both come from home and are what they say.
    second.want(data, [bundle])
    await waitFor(() => second.readyData().includes(set.manifest) && second.readyBundles().includes(id), 'both fetched again')
    assert.equal(sha256(fs.readFileSync(path.join(second.dataDir(set.manifest, 'compabcd'), 'train.csv'))), file!.sha256)
    assert.equal(sha256(fs.readFileSync(path.join(bundleDir(id), 'wheels', 'w-1.0-py3-none-any.whl'))), wheelSha)
  } finally {
    second.stop()
    await home.close()
  }
})

test('a hash is booked by inode, length and mtime: a restart and a reused set or data folder read no blob again, and marking a blob used keeps it booked', async (t) => {
  const home = await fakeHome()
  const set = dataSet({ 'train.csv': 'id,x\n'.repeat(500) })
  const wheelBody = Buffer.from('a wheel, booked')
  const wheelSha = sha256(wheelBody)
  for (const [sha, body] of [...set.bodies, [wheelSha, wheelBody] as const]) home.blobs.set(sha, body)
  const id = hex(16)
  const bundle: RemoteWantBundle = { id, packagesMb: 64, lock: 'b==1.0 --hash=sha256:aa\n', wheels: [{ fileName: 'b-1.0-py3-none-any.whl', sha256: wheelSha, bytes: wheelBody.length }] }
  const data = [{ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files }]
  // A clock an hour ahead: a touch sets an mtime the arrival never had.
  const first = cacheFor(home, { now: () => Date.now() + 3_600_000 })
  first.want(data, [bundle])
  await waitFor(() => first.readyData().includes(set.manifest) && first.readyBundles().includes(id), 'in place')
  first.dataDir(set.manifest, 'compabcd')
  // Used again: the folder is reused, and the blobs are marked used (their mtime moves).
  first.dataDir(set.manifest, 'compabcd')
  await first.bundle(id)
  first.stop()
  const read: string[] = []
  const open = fs.openSync
  t.mock.method(fs, 'openSync', (file: fs.PathLike, ...rest: unknown[]) => {
    if (!String(file).includes('/books/')) read.push(String(file))
    return (open as (...args: unknown[]) => number)(file, ...rest)
  })
  const second = cacheFor(home)
  try {
    assert.deepEqual(second.readyData(), [set.manifest])
    assert.deepEqual(second.readyBundles(), [id])
    second.dataDir(set.manifest, 'compabcd')
    assert.equal(await second.bundle(id), bundleDir(id))
    assert.deepEqual(read, [], 'a file booked by its hash was read again')
  } finally {
    t.mock.restoreAll()
    second.stop()
    await home.close()
  }
})

test('a drain\'s purge spares the hidden test of the runs still held, and only that', async () => {
  const home = await fakeHome()
  const cache = cacheFor(home)
  try {
    const open = dataSet({ 'train.csv': 'id,y\n1,0\n' })
    const held = dataSet({ 'test.csv': 'id\n7\n' })
    const other = dataSet({ 'test.csv': 'id\n8\n' })
    for (const [sha, body] of [...open.bodies, ...held.bodies, ...other.bodies]) home.blobs.set(sha, body)
    cache.want([
      { competitionId: 'compabcd', manifest: open.manifest, sealed: false, files: open.files },
      { competitionId: 'compabcd', manifest: held.manifest, sealed: true, files: held.files },
      { competitionId: 'compother', manifest: other.manifest, sealed: true, files: other.files },
    ], [])
    await waitFor(() => cache.readySealed().length === 2 && cache.readyData().length === 1, 'all three')
    cache.purgeSealed('drain', new Set([held.manifest, open.manifest]))
    assert.deepEqual(cache.readySealed(), [held.manifest], 'the hidden test a held run reads was purged, or another one kept')
    assert.deepEqual(fs.readdirSync(sealedDir()), [held.files[0]!.sha256])
    // The held run links its inputs after the purge, as a lease waiting on its image does.
    const lease = makeLease({ data: open.manifest, sealed: true, sealedData: held.manifest })
    assert.equal(fs.readFileSync(path.join(cache.composeSealed(lease), 'test.csv'), 'utf8'), 'id\n7\n')
    // An untrust keeps nothing.
    cache.purgeSealed('untrusted')
    assert.deepEqual(fs.readdirSync(sealedDir()), [])
    assert.ok(!cache.holdsSealed())
  } finally {
    cache.stop()
    await home.close()
  }
})

test('below its floor the disk takes no prefetch, a lease\'s blob only within what the machine promised home, and a write it refuses waits instead of retrying', async (t) => {
  const home = await fakeHome()
  let room = false
  const fulls: string[] = []
  // The floors as sync.ts · mayFetch keeps them, in a test's numbers: a lease's blob of under 100 bytes fits, a prefetch only with room.
  const cache = cacheFor(home, { diskGate: (bytes, forLease) => room || (forLease && bytes < 100), onDiskFull: (detail) => fulls.push(detail), diskWaitMs: 300 })
  try {
    const set = dataSet({ 'big.csv': 'x'.repeat(5000) })
    for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
    cache.want([{ competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files }], [])
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.ok(!home.calls.some((call) => call.path.includes('/blobs/')), 'a prefetch started below the floor')
    // A lease's small blob is fetched; a big one is refused for the disk, at once, which declines its lease for `disk`.
    const small = Buffer.from('tiny')
    home.blobs.set(sha256(small), small)
    assert.equal(fs.readFileSync(await cache.blob(sha256(small), small.length)).toString(), 'tiny')
    const big = Buffer.alloc(200, 0x31)
    home.blobs.set(sha256(big), big)
    await assert.rejects(cache.blob(sha256(big), big.length), (error: unknown) => error instanceof CacheError && error.kind === 'disk')
    // Room: the prefetch goes on by itself.
    room = true
    await waitFor(() => cache.readyData().includes(set.manifest), 'the prefetch after the wait')

    // A write the disk refuses (ENOSPC): said once, the partial file gone, and the blob not asked for again until the wait is over.
    const third = Buffer.from('y'.repeat(3000))
    const thirdSha = sha256(third)
    home.blobs.set(thirdSha, third)
    const partFds = new Set<number>()
    let full = true
    const open = fs.openSync
    const write = fs.writeSync
    t.mock.method(fs, 'openSync', (file: fs.PathLike, ...rest: unknown[]) => {
      const fd = (open as (...args: unknown[]) => number)(file, ...rest)
      if (String(file).endsWith(`.${thirdSha}.part`)) partFds.add(fd)
      return fd
    })
    t.mock.method(fs, 'writeSync', (fd: number, ...rest: unknown[]) => {
      if (full && partFds.has(fd)) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      return (write as (...args: unknown[]) => number)(fd, ...rest)
    })
    cache.want([
      { competitionId: 'compabcd', manifest: set.manifest, sealed: false, files: set.files },
      { competitionId: 'compabcd', manifest: dataSet({ 'third.csv': third.toString() }).manifest, sealed: false, files: [{ name: 'third.csv', sha256: thirdSha, bytes: third.length }] },
    ], [])
    await waitFor(() => fulls.length > 0, 'the disk said full')
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(home.calls.filter((call) => call.path.endsWith(thirdSha)).length, 1, 'a write the disk refused was retried at once')
    assert.match(fulls[0]!, /no space left on device/)
    assert.ok(!fs.existsSync(path.join(blobsDir(), `.${thirdSha}.part`)), 'the partial file kept the room the disk lacked')
    full = false
    await waitFor(() => fs.existsSync(path.join(blobsDir(), thirdSha)), 'fetched once the disk has room')
  } finally {
    t.mock.restoreAll()
    cache.stop()
    await home.close()
  }
})

test('one manifest for two competitions is fetched once and laid out for each, forgetting one keeps it for the other; one hash both open and hidden is kept as both', async () => {
  const home = await fakeHome()
  const cache = cacheFor(home)
  try {
    const set = dataSet({ 'train.csv': 'id\n1\n2\n' })
    for (const [sha, body] of set.bodies) home.blobs.set(sha, body)
    // What home's want may say since the same files may be listed twice (shared/remote-runner.ts · wantOf).
    cache.want([
      { competitionId: 'compaaaa', manifest: set.manifest, sealed: false, files: set.files },
      { competitionId: 'compbbbb', manifest: set.manifest, sealed: false, files: set.files },
      { competitionId: 'compaaaa', manifest: set.manifest, sealed: true, files: set.files },
    ], [])
    await waitFor(() => cache.readyData().includes(set.manifest) && cache.readySealed().includes(set.manifest), 'ready as open data and as a hidden test')
    // Once into the open data, once apart for the hidden test.
    assert.equal(home.calls.filter((call) => call.path.endsWith(set.files[0]!.sha256)).length, 2)
    assert.ok(fs.existsSync(path.join(sealedDir(), set.files[0]!.sha256)))
    const a = cache.dataDir(set.manifest, 'compaaaa')
    const b = cache.dataDir(set.manifest, 'compbbbb')
    assert.equal(a, path.join(competitionsDir, 'compaaaa', 'inputs', set.manifest.slice(0, 12)))
    assert.equal(b, path.join(competitionsDir, 'compbbbb', 'inputs', set.manifest.slice(0, 12)))
    assert.deepEqual(cache.fetchingList(), [])
    // A competition closed: its folder and its hidden test go, the other's data stays.
    cache.forget(['compaaaa'])
    assert.ok(!fs.existsSync(a))
    assert.ok(fs.existsSync(b))
    assert.deepEqual(cache.readyData(), [set.manifest])
    assert.deepEqual(cache.readySealed(), [])
    // The next life knows what this one did.
    cache.stop()
    const again = cacheFor(home)
    assert.deepEqual(again.readyData(), [set.manifest])
    assert.deepEqual(again.manifest(set.manifest)?.competitions, ['compbbbb'])
    again.stop()
  } finally {
    cache.stop()
    await home.close()
  }
})
