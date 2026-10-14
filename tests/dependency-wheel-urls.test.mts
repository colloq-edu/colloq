/**
 * A ready set's manifest keeps where each wheel came from, next to its sha256
 * and size, and the hasher behind every content address reads a file once.
 *
 * The machines that run submissions for a server will fetch a set's wheels
 * from the index's CDN by these addresses and check them by hash, instead of
 * pulling half a gigabyte through the server's tunnel. So an address must come
 * from pip's report as the program checked it, pass the same check once more
 * on this side, and stay out of everything the class can read: an
 * institution's mirror is not named to the class. That is more than the
 * pages: the set's folder, manifest.json included, is the participant's own
 * /deps, and the set's row is what 0.22 hands the participant's page as it
 * finds it after a rollback. So the addresses live in a table of their own.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { PREPARATION_PYTHON } from '../server/src/dependencies/preparation-python.ts'
import { manifestPackages, wheelUrl, wheelUrls } from '../server/src/dependencies/preparation-contract.ts'
import { bundleDir, cachedSha256, freshStaging, publishBundle } from '../server/src/dependencies/files.ts'
import { bundleWheels, completeBundle, createBundle, getBundle, listBundles, moveWheelUrlsApart, putRevision, selectRevision, setPolicy } from '../server/src/dependencies/store.ts'
import { db } from '../server/src/db.ts'
import { createCompetition, createEntrant, setCompetitionState } from '../server/src/competitions/store.ts'
import type { DependencyPackage } from '../shared/dependencies.ts'

const PYPI = ['files.pythonhosted.org:443']
const WHEEL = 'numpy-2.1.0-cp311-cp311-manylinux_2_17_x86_64.whl'
const URL_OF = (name: string) => `https://files.pythonhosted.org/packages/4b/d7/ecf66c1cd12dc28b4040b15ab4d17b773b87fa9d29ca16125de01adb36cd/${name}`

function python(code: string) {
  const result = spawnSync('python3', ['-c', `__name__ = 'test_helper'\n${PREPARATION_PYTHON}\n${code}`], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

test("the preparation program records each wheel's address from pip's report, not where a redirect ended", () => {
  const out = python(`
import io, tempfile
class Response:
    def __init__(self, body):
        self.status, self.url, self.stream = 200, 'https://files.pythonhosted.org/redirected/elsewhere.whl', io.BytesIO(body)
        self.headers = {'Content-Length': str(len(body))}
    def read(self, size): return self.stream.read(size)
    def __enter__(self): return self
    def __exit__(self, *args): return False
class Opener:
    def __init__(self, bodies): self.bodies = bodies
    def open(self, url, timeout=None): return Response(self.bodies[url])
with tempfile.TemporaryDirectory() as source, tempfile.TemporaryDirectory() as target:
    WHEELS = pathlib.Path(target)
    plan, bodies = [], {}
    for name in ('alpha', 'beta'):
        file = pathlib.Path(source) / (name + '-1.0-py3-none-any.whl')
        with zipfile.ZipFile(file, 'w') as archive:
            archive.writestr(name + '-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: ' + name + '\\nVersion: 1.0\\n')
            archive.writestr(name + '/payload.bin', b'x' * 10)
        body = file.read_bytes()
        url = 'https://files.pythonhosted.org/packages/aa/bb/' + file.name
        plan.append((name, '1.0', url, file.name, hashlib.sha256(body).hexdigest()))
        bodies[url] = body
    packages, downloaded = download_wheels(plan, {}, {'maxDownloadBytes': 10 ** 6, 'maxInstalledBytes': 10 ** 6}, Opener(bodies))
    print('PACKAGES ' + json.dumps(packages))
`)
  // The program's own progress lines come first; the answer is the marked last line.
  const packages = JSON.parse(out.split('\n').find((line) => line.startsWith('PACKAGES '))!.slice('PACKAGES '.length)) as DependencyPackage[]
  assert.deepEqual(packages.map((pkg) => pkg.url), [
    'https://files.pythonhosted.org/packages/aa/bb/alpha-1.0-py3-none-any.whl',
    'https://files.pythonhosted.org/packages/aa/bb/beta-1.0-py3-none-any.whl',
  ])
  // Next to the sha256 and the size it was checked against.
  for (const pkg of packages) {
    assert.match(pkg.sha256, /^[a-f0-9]{64}$/)
    assert.ok(pkg.bytes > 0)
    assert.equal(pkg.fileName, pkg.url!.split('/').pop())
  }
})

test("an address passes only as the program's own check passed it: https, the index's file host, the wheel's own name", () => {
  assert.equal(wheelUrl(URL_OF(WHEEL), WHEEL, PYPI), URL_OF(WHEEL))
  // The local version's plus is percent-encoded in PyPI's paths; the name is compared decoded.
  const torch = 'torch-2.3.0+cpu-cp311-cp311-linux_x86_64.whl'
  assert.equal(wheelUrl(URL_OF('torch-2.3.0%2Bcpu-cp311-cp311-linux_x86_64.whl'), torch, PYPI), URL_OF('torch-2.3.0%2Bcpu-cp311-cp311-linux_x86_64.whl'))
  const refused = [
    URL_OF(WHEEL).replace('https:', 'http:'),
    URL_OF(WHEEL).replace('https://', 'https://user:secret@'),
    `${URL_OF(WHEEL)}#sha256=${'a'.repeat(64)}`,
    URL_OF(WHEEL).replace('files.pythonhosted.org', 'evil.example'),
    URL_OF(WHEEL).replace('files.pythonhosted.org', 'files.pythonhosted.org:8443'),
    URL_OF('numpy-2.0.0-cp311-cp311-manylinux_2_17_x86_64.whl'),
    `${URL_OF(WHEEL).slice(0, -WHEEL.length)}${'a'.repeat(2100)}/${WHEEL}`,
    'not a url',
    42,
    null,
    undefined,
  ]
  for (const raw of refused) assert.equal(wheelUrl(raw, WHEEL, PYPI), undefined, String(raw))
  // A mirror's own host and port, as DEPENDENCY_FILES_HOSTS names it.
  const mirror = `https://nexus.campus.example:8443/repository/pypi/packages/${WHEEL}`
  assert.equal(wheelUrl(mirror, WHEEL, ['nexus.campus.example:8443']), mirror)
  assert.equal(wheelUrl(mirror, WHEEL, PYPI), undefined)
})

test('the manifest keeps the fields of a package, nothing a program put beside them and no address; the checked addresses come apart', () => {
  const reported = [
    { name: 'numpy', version: '2.1.0', fileName: WHEEL, sha256: 'a'.repeat(64), bytes: 10, url: URL_OF(WHEEL), extra: 'dropped' },
    { name: 'pandas', version: '2.2.0', fileName: 'pandas-2.2.0-py3-none-any.whl', sha256: 'b'.repeat(64), bytes: 20, url: 'https://evil.example/pandas-2.2.0-py3-none-any.whl' },
    { name: 'scipy', version: '1.14.0', fileName: 'scipy-1.14.0-py3-none-any.whl', sha256: 'c'.repeat(64), bytes: 30 },
  ] as unknown as DependencyPackage[]
  assert.deepEqual(manifestPackages(reported), [
    { name: 'numpy', version: '2.1.0', fileName: WHEEL, sha256: 'a'.repeat(64), bytes: 10 },
    { name: 'pandas', version: '2.2.0', fileName: 'pandas-2.2.0-py3-none-any.whl', sha256: 'b'.repeat(64), bytes: 20 },
    { name: 'scipy', version: '1.14.0', fileName: 'scipy-1.14.0-py3-none-any.whl', sha256: 'c'.repeat(64), bytes: 30 },
  ])
  // An address that fails the check is dropped, not the wheel: the machine takes it from the server.
  assert.deepEqual(wheelUrls(reported, PYPI), [{ sha256: 'a'.repeat(64), url: URL_OF(WHEEL) }])
})

let seq = 0
function readySet(url?: string) {
  const c = createCompetition({ slug: `wheel-urls-${++seq}`, title: 'Wheels', environment: 'base' })!
  setCompetitionState(c.id, 'live')
  const e = createEntrant(`Wheel tester ${seq}`).entrant
  const r = putRevision({ environmentName: 'base', imageDigest: `sha256:${'e'.repeat(64)}`, pythonVersion: '3.11.16', pythonAbi: 'cp311', platform: 'linux/amd64', packages: [{ name: 'pip', version: '25.1' }], baseConstraintsHash: 'hash' })
  selectRevision(c.id, r.id)
  setPolicy(c.id, { enabled: true })
  const bundle = createBundle(c.id, e.id, r.id, 'example==1.0')
  const bytes = Buffer.from(`wheel fixture ${randomUUID()}`)
  const fileName = 'example-1.0-py3-none-any.whl'
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const pkg = { name: 'example', version: '1.0', fileName, sha256, bytes: bytes.length, url: url ?? URL_OF(fileName) }
  // As a program reported it: with a field of its own beside the package's, which the manifest does not keep.
  const reported = { ...pkg, downloadedFrom: 'https://files.pythonhosted.org/redirected/elsewhere.whl' }
  const result = { normalizedRequirements: ['example==1.0'], packages: [reported], downloadBytes: bytes.length, installedBytes: bytes.length, contentHash: sha256, lock: `example==1.0 --hash=sha256:${sha256}\n` }
  const stage = freshStaging(bundle.id)
  fs.mkdirSync(path.join(stage, 'wheels'))
  fs.writeFileSync(path.join(stage, 'wheels', fileName), bytes)
  return { c, e, bundle, pkg, result }
}

test("a published set keeps each wheel's address for the machines alone: not in the participant's /deps, not in the row older code serves", async () => {
  const { c, e, bundle, pkg, result } = readySet()
  await publishBundle(bundle.id, result)
  const { url: _url, ...shown } = pkg
  // The set's folder is mounted into the participant's container at /deps: its manifest names no address.
  const manifest = fs.readFileSync(path.join(bundleDir(bundle.id), 'manifest.json'), 'utf8')
  assert.deepEqual((JSON.parse(manifest) as { packages: DependencyPackage[] }).packages, [shown])
  assert.ok(!manifest.includes('pythonhosted'))
  assert.equal(completeBundle(bundle.id, result), true)
  // The row as 0.22 reads it, and hands it to the participant's page as it finds it.
  const row = db.prepare('SELECT packages_json FROM dependency_bundles WHERE id = ?').get(bundle.id) as { packages_json: string }
  assert.deepEqual(JSON.parse(row.packages_json), [shown])
  assert.deepEqual(bundleWheels(bundle.id), [pkg], 'the machines that run submissions get the address, kept apart')
  // What the participant's and the teacher's pages are built from.
  assert.deepEqual(getBundle(bundle.id)?.packages, [shown])
  assert.deepEqual(listBundles(c.id, e.id)[0]?.packages, [shown])
  assert.ok(!JSON.stringify(listBundles(c.id)).includes('pythonhosted'), 'no address reaches an overview')
})

test('a set completed with its addresses in its row has them moved apart, and keeps them for the machines', async () => {
  const { bundle, pkg, result } = readySet()
  await publishBundle(bundle.id, result)
  assert.equal(completeBundle(bundle.id, result), true)
  // As this release wrote a row before the addresses had a table of their own.
  db.prepare('DELETE FROM dependency_bundle_wheel_urls WHERE bundle_id = ?').run(bundle.id)
  db.prepare('UPDATE dependency_bundles SET packages_json = ? WHERE id = ?').run(JSON.stringify([pkg]), bundle.id)
  assert.ok(moveWheelUrlsApart() >= 1)
  const { url: _url, ...shown } = pkg
  const row = db.prepare('SELECT packages_json FROM dependency_bundles WHERE id = ?').get(bundle.id) as { packages_json: string }
  assert.deepEqual(JSON.parse(row.packages_json), [shown])
  assert.deepEqual(bundleWheels(bundle.id), [pkg])
  assert.equal(moveWheelUrlsApart(), 0, 'once')
})

test('an address that fails the check stays out of the manifest and the row, and the set is ready without it', async () => {
  const { bundle, pkg, result } = readySet('https://evil.example/packages/example-1.0-py3-none-any.whl')
  await publishBundle(bundle.id, result)
  const { url: _url, ...kept } = pkg
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir(bundle.id), 'manifest.json'), 'utf8')) as { packages: DependencyPackage[] }
  assert.deepEqual(manifest.packages, [kept])
  assert.equal(completeBundle(bundle.id, result), true)
  assert.deepEqual(bundleWheels(bundle.id), [kept])
  assert.equal(getBundle(bundle.id)?.state, 'ready')
})

test('a set that is not ready has no wheels to fetch', () => {
  const { bundle } = readySet()
  assert.equal(bundleWheels(bundle.id), null)
  assert.equal(bundleWheels('0'.repeat(32)), null)
})

test('the hasher reads a file once per identity, again after a rewrite, and once for callers asking together', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.DATA_DIR!, 'hasher-'))
  const file = path.join(dir, 'data.csv')
  fs.writeFileSync(file, 'id,target\n1,0\n')
  let reads = 0
  const read = () => { reads++; return fs.createReadStream(file) }
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  const stat = fs.statSync(file)
  assert.equal(await cachedSha256(file, stat, read), digest('id,target\n1,0\n'))
  assert.equal(await cachedSha256(file, fs.statSync(file), read), digest('id,target\n1,0\n'))
  assert.equal(reads, 1, 'an unchanged file is not read a second time')
  // The same size, rewritten in place: mtime and ctime move, and it is read again.
  await new Promise((resolve) => setTimeout(resolve, 20))
  fs.writeFileSync(file, 'id,target\n1,1\n')
  assert.equal(await cachedSha256(file, fs.statSync(file), read), digest('id,target\n1,1\n'))
  assert.equal(reads, 2)
  // Two asks of a new identity at once share one read.
  await new Promise((resolve) => setTimeout(resolve, 20))
  fs.writeFileSync(file, 'id,target\n1,2\n')
  const now = fs.statSync(file)
  const [a, b] = await Promise.all([cachedSha256(file, now, read), cachedSha256(file, now, read)])
  assert.equal(a, digest('id,target\n1,2\n'))
  assert.equal(b, a)
  assert.equal(reads, 3, 'two callers at once made one read')
})
