/**
 * What an environment revision's image is beyond this machine: a registry
 * reference another machine can pull, and a fingerprint of the image's layers
 * it checks after the pull.
 *
 * The fixtures are `docker image inspect` of one image as the two image
 * stores print it. They disagree on `.Id` (the classic store's is the config's
 * digest, the containerd store's the index's) and on RepoDigests (the
 * containerd store lists every local name with the digest, an image built
 * here included), and agree on RootFS.Layers. A wrong fingerprint makes the
 * machines refuse a good image; a wrong reference makes them pull another one,
 * or none: both are checked here, without a daemon.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { db } from '../server/src/db.js'
import { imageIdentity, kernelImageRepo, layersFingerprint, registryRefOf } from '../server/src/dependencies/image-identity.js'
import { getRevision, noteRevisionImage, putRevision } from '../server/src/dependencies/store.js'
import { backfillRevisionImages, captureRevision, useDockerForRevisions } from '../server/src/dependencies/revisions.js'

const hex = (seed: string) => createHash('sha256').update(seed).digest('hex')
const DIFF_IDS = ['debian-bookworm', 'python-3.12', 'pip-base', 'kaggle-stack', 'harness-user'].map((layer) => `sha256:${hex(layer)}`)
const INDEX = `sha256:${hex('the published index')}`
const CONFIG = `sha256:${hex('the image config')}`
const GHCR = 'ghcr.io/colloq-edu/colloq-kernel'

/** `docker image inspect colloq-kernel:kaggle-base` on Docker 27, the classic store (overlay2). */
const CLASSIC = {
  Id: CONFIG,
  RepoTags: ['colloq-kernel:kaggle-base', `${GHCR}:v0.22.0-kaggle-base`],
  RepoDigests: [`${GHCR}@${INDEX}`],
  Parent: '',
  Comment: 'buildkit.dockerfile.v0',
  Created: '2026-10-11T09:12:44.123456789Z',
  DockerVersion: '',
  Author: '',
  Config: { User: '1000', Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'PYTHONDONTWRITEBYTECODE=1'], Cmd: ['python3'], WorkingDir: '/home/jovyan', Labels: { 'org.opencontainers.image.source': 'https://github.com/colloq-edu/colloq' } },
  Architecture: 'amd64',
  Os: 'linux',
  Size: 3_421_771_104,
  GraphDriver: { Data: { LowerDir: '/var/lib/docker/overlay2/l/ABC:/var/lib/docker/overlay2/l/DEF', MergedDir: '/var/lib/docker/overlay2/x/merged' }, Name: 'overlay2' },
  RootFS: { Type: 'layers', Layers: DIFF_IDS },
  Metadata: { LastTagTime: '2026-10-11T09:20:01.511216Z' },
}

/** The same image on Docker 28 with the containerd image store. */
const CONTAINERD = {
  Id: INDEX,
  RepoTags: ['colloq-kernel:kaggle-base', `${GHCR}:v0.22.0-kaggle-base`, 'colloq-revision:0123456789abcdef0123456789abcdef'],
  // Every local name, with the target's digest: the local ones first.
  RepoDigests: [`colloq-kernel@${INDEX}`, `colloq-revision@${INDEX}`, `${GHCR}@${INDEX}`],
  Parent: '',
  Comment: 'buildkit.dockerfile.v0',
  Created: '2026-10-11T09:12:44.123456789Z',
  Config: { User: '1000', Env: ['PATH=/usr/local/bin:/usr/bin:/bin'], Cmd: ['python3'], WorkingDir: '/home/jovyan' },
  Architecture: 'amd64',
  Os: 'linux',
  Size: 1_033_119_870,
  GraphDriver: { Data: null, Name: 'overlayfs' },
  RootFS: { Type: 'layers', Layers: DIFF_IDS },
  Metadata: { LastTagTime: '0001-01-01T00:00:00Z' },
  Descriptor: { mediaType: 'application/vnd.oci.image.index.v1+json', digest: INDEX, size: 856 },
}

test('the classic and the containerd stores give one image one fingerprint, and the same reference', () => {
  const classic = imageIdentity(CLASSIC, GHCR)
  const containerd = imageIdentity(CONTAINERD, GHCR)
  assert.notEqual(CLASSIC.Id, CONTAINERD.Id, 'the fixtures disagree on .Id, as the stores do')
  assert.equal(classic.layers, layersFingerprint('linux', 'amd64', DIFF_IDS))
  assert.equal(containerd.layers, classic.layers)
  assert.equal(classic.registryRef, `${GHCR}@${INDEX}`)
  assert.equal(containerd.registryRef, classic.registryRef, 'a local name of the containerd store was taken for a registry')
})

test('the fingerprint is the text the machines that run submissions hash, byte for byte', () => {
  // Pinned on purpose: a change here is a change of every stored pin, and the
  // machines compute the same text over their own inspect.
  assert.equal(
    layersFingerprint('linux', 'amd64', [DIFF_IDS[0]!, DIFF_IDS[1]!]),
    hex(`colloq.remote.layers.v1\nlinux/amd64\n${DIFF_IDS[0]}\n${DIFF_IDS[1]}\n`),
  )
})

test('the fingerprint is the platform and the layers in order, and nothing a store may or may not print', () => {
  const amd = imageIdentity(CLASSIC, GHCR).layers
  assert.notEqual(imageIdentity({ ...CLASSIC, Architecture: 'arm64' }, GHCR).layers, amd, 'another platform is another image')
  assert.notEqual(imageIdentity({ ...CLASSIC, RootFS: { Type: 'layers', Layers: [...DIFF_IDS].reverse() } }, GHCR).layers, amd)
  // arm64 is arm64/v8 in one store and plain arm64 in the other.
  assert.equal(imageIdentity({ ...CLASSIC, Architecture: 'arm64', Variant: 'v8' }, GHCR).layers, imageIdentity({ ...CONTAINERD, Architecture: 'arm64' }, GHCR).layers)
  assert.equal(imageIdentity({ ...CLASSIC, Id: `sha256:${hex('another id')}`, Size: 1, Created: 'later' }, GHCR).layers, amd)
  for (const broken of [
    { ...CLASSIC, RootFS: { Type: 'other', Layers: DIFF_IDS } },
    { ...CLASSIC, RootFS: { Type: 'layers', Layers: [] } },
    { ...CLASSIC, RootFS: { Type: 'layers', Layers: [...DIFF_IDS, 'sha256:short'] } },
    { ...CLASSIC, RootFS: undefined },
    { ...CLASSIC, Os: undefined },
    { ...CLASSIC, Architecture: 'amd 64' },
    // Never adjusted into shape: the machine would not adjust its own either.
    { ...CLASSIC, Os: 'Linux' },
    { ...CLASSIC, RootFS: { Type: 'layers', Layers: Array.from({ length: 257 }, (_, i) => `sha256:${hex(String(i))}`) } },
  ]) {
    assert.equal(imageIdentity(broken, GHCR).layers, null, JSON.stringify(broken.RootFS ?? null) + broken.Architecture)
  }
  assert.deepEqual(imageIdentity(null), { registryRef: null, layers: null })
  assert.deepEqual(imageIdentity([CLASSIC]), { registryRef: null, layers: null }, 'the array docker prints is not one image')
})

test('an image built here and never pushed runs at home only, in both stores', () => {
  assert.equal(imageIdentity({ ...CLASSIC, RepoDigests: [] }, GHCR).registryRef, null)
  assert.equal(imageIdentity({ ...CONTAINERD, RepoDigests: [`colloq-kernel@${INDEX}`, `colloq-revision@${INDEX}`] }, GHCR).registryRef, null)
  assert.equal(imageIdentity({ ...CLASSIC, RepoDigests: undefined }, GHCR).registryRef, null)
  // The fingerprint is there all the same: the image is known, only not reachable.
  assert.ok(imageIdentity({ ...CLASSIC, RepoDigests: [] }, GHCR).layers)
})

test('the reference prefers the kernels\' repository, names any other registry, and never a loopback or a bare name by itself', () => {
  const mirror = `registry.campus.example:5000/ml/kernel@${INDEX}`
  assert.equal(registryRefOf([mirror, `${GHCR}@${INDEX}`], GHCR), `${GHCR}@${INDEX}`, 'the published repository comes first')
  assert.equal(registryRefOf([mirror], GHCR), mirror, 'an institution\'s registry is a registry')
  assert.equal(registryRefOf([`localhost:5000/colloq-edu/colloq-kernel@${INDEX}`], GHCR), null, 'no other machine reaches this one\'s loopback')
  assert.equal(registryRefOf([`127.0.0.1:5000/colloq-edu/colloq-kernel@${INDEX}`], GHCR), null)
  assert.equal(registryRefOf([`localhost:5000/colloq-edu/colloq-kernel@${INDEX}`], 'localhost:5000/colloq-edu/colloq-kernel'), `localhost:5000/colloq-edu/colloq-kernel@${INDEX}`, 'unless the operator named it')
  // Docker Hub in docker's short form, only when it is the operator's own repository.
  assert.equal(registryRefOf([`myorg/kernels@${INDEX}`], GHCR), null)
  assert.equal(registryRefOf([`myorg/kernels@${INDEX}`], 'myorg/kernels'), `docker.io/myorg/kernels@${INDEX}`)
  assert.equal(registryRefOf([`myorg/kernels@${INDEX}`], 'docker.io/myorg/kernels'), `docker.io/myorg/kernels@${INDEX}`)
  for (const junk of [`${GHCR}@sha256:short`, `${GHCR}:tag`, `Upper/Case@${INDEX}`, `@${INDEX}`, 42, null]) {
    assert.equal(registryRefOf([junk], GHCR), null, String(junk))
  }
  assert.equal(registryRefOf('not a list', GHCR), null)
  assert.equal(registryRefOf([mirror, `${GHCR}@${INDEX}`], null), mirror, 'with nothing preferred, the first registry')
})

test("the preferred repository is the operator's, else the one the image was built with, else the public one", () => {
  assert.equal(kernelImageRepo({}), GHCR)
  assert.equal(kernelImageRepo({ COLLOQ_KERNEL_REPO: 'registry.example/kernels' }), 'registry.example/kernels')
  assert.equal(kernelImageRepo({ KERNEL_IMAGE_REPO: 'mirror.example/k', COLLOQ_KERNEL_REPO: 'registry.example/kernels' }), 'mirror.example/k')
  assert.equal(kernelImageRepo({ KERNEL_IMAGE_REPO: 'none' }), null)
})

/* ------------------------------------------------------- what is recorded */

const revisionOf = (digest: string) => putRevision({ environmentName: 'base', imageDigest: digest, pythonVersion: '3.12.1', pythonAbi: 'cpython-312-x86_64-linux-gnu', platform: 'linux/amd64', packages: [{ name: 'pip', version: '25.1' }], baseConstraintsHash: 'hash' })
const id = () => `sha256:${hex(randomUUID())}`

test('an older server can still record a revision: its positional insert fits the table it finds', () => {
  const key = randomUUID().replaceAll('-', '')
  // 0.22's putRevision, word for word.
  db.prepare('INSERT INTO environment_revisions VALUES (?,?,?,?,?,?,?,?,?)').run(key, 'base', id(), '3.11.1', 'cp311', 'linux/amd64', '[]', 'hash', Date.now())
  const recorded = getRevision(key)
  assert.ok(recorded)
  assert.equal(recorded.registryRef, null)
  assert.equal(recorded.layers, null)
})

test('what an inspect says is kept; a null never erases what is known, a new reference replaces the old', () => {
  const revision = revisionOf(id())
  assert.equal(revision.registryRef, null)
  assert.equal(noteRevisionImage(revision.id, { registryRef: `${GHCR}@${INDEX}`, layers: 'a'.repeat(64) }), true)
  assert.deepEqual([getRevision(revision.id)?.registryRef, getRevision(revision.id)?.layers], [`${GHCR}@${INDEX}`, 'a'.repeat(64)])
  assert.equal(noteRevisionImage(revision.id, { registryRef: null, layers: null }), false)
  assert.equal(noteRevisionImage(revision.id, { registryRef: null, layers: 'a'.repeat(64) }), false)
  assert.equal(getRevision(revision.id)?.registryRef, `${GHCR}@${INDEX}`, 'a tag removed here is no reason to forget the registry')
  const moved = `registry.example/kernels@${INDEX}`
  assert.equal(noteRevisionImage(revision.id, { registryRef: moved, layers: 'a'.repeat(64) }), true)
  assert.equal(getRevision(revision.id)?.registryRef, moved)
  // A revision copied into another one's fields does not hand it its reference.
  const copied = putRevision({ ...getRevision(revision.id)!, imageDigest: id() })
  assert.deepEqual([copied.registryRef, copied.layers], [null, null])
  // Nothing out of shape is kept: a tag is no pin, and a fingerprint is 64 hex.
  assert.equal(noteRevisionImage(copied.id, { registryRef: `${GHCR}:v0.22.0-base`, layers: 'not a fingerprint' }), false)
  assert.equal(noteRevisionImage(copied.id, { registryRef: `${GHCR}@${INDEX} --insecure`, layers: 'b'.repeat(63) }), false)
  assert.deepEqual([getRevision(copied.id)?.registryRef, getRevision(copied.id)?.layers], [null, null])
})

/** Docker for revisions.ts, answering from a table; a missing image throws, as execFile does. */
function fakeDocker(images: Map<string, object>, calls: string[][]) {
  return async (args: string[]): Promise<string> => {
    calls.push(args)
    if (args[0] === 'image' && args[1] === 'inspect') {
      const image = images.get(args[2]!)
      if (!image) throw Object.assign(new Error(`Error: No such image: ${args[2]}`), { code: 1 })
      return JSON.stringify([image])
    }
    if (args[0] === 'run') return JSON.stringify({ python: '3.12.1', abi: 'cpython-312-x86_64-linux-gnu', packages: [{ name: 'numpy', version: '2.1.0' }, { name: 'pip', version: '25.1' }] })
    return ''
  }
}

async function withBackend<T>(backend: string, body: () => Promise<T>): Promise<T> {
  const before = process.env.COMPETITION_BACKEND
  process.env.COMPETITION_BACKEND = backend
  try {
    return await body()
  } finally {
    useDockerForRevisions(null)
    if (before === undefined) delete process.env.COMPETITION_BACKEND
    else process.env.COMPETITION_BACKEND = before
  }
}

test('a captured revision records its identity, and an image pushed since gains its reference at the next capture', async () => {
  await withBackend('docker', async () => {
    const local = { ...CLASSIC, Id: id(), RepoDigests: [] }
    const images = new Map<string, object>([['colloq-kernel:base', local]])
    const calls: string[][] = []
    useDockerForRevisions(fakeDocker(images, calls))
    const first = await captureRevision('base')
    assert.equal(first.imageDigest, local.Id)
    assert.equal(first.registryRef, null, 'built here: runs at home only')
    assert.equal(first.layers, layersFingerprint('linux', 'amd64', DIFF_IDS))
    // `make kernel-publish` pushed it since: the same image, now with a repository digest.
    images.set('colloq-kernel:base', { ...local, RepoDigests: [`${GHCR}@${INDEX}`] })
    const again = await captureRevision('base')
    assert.equal(again.id, first.id, 'the same image is the same revision')
    assert.equal(again.registryRef, `${GHCR}@${INDEX}`)
    assert.equal(getRevision(first.id)?.registryRef, `${GHCR}@${INDEX}`)
  })
})

test("older revisions learn their images' identity at startup, by their tag or their id, and never from a moved tag", async () => {
  await withBackend('docker', async () => {
    const tagged = revisionOf(id())
    const untagged = revisionOf(id())
    const moved = revisionOf(id())
    const catalog = revisionOf(`registry.example/colloq-kernel@${INDEX}`)
    const images = new Map<string, object>([
      [`colloq-revision:${tagged.id}`, { ...CLASSIC, Id: tagged.imageDigest }],
      [untagged.imageDigest, { ...CONTAINERD, Id: untagged.imageDigest, RepoDigests: [`colloq-kernel@${untagged.imageDigest}`] }],
      // The tag now names another image, and the revision's own image is gone.
      [`colloq-revision:${moved.id}`, { ...CLASSIC, Id: id() }],
    ])
    const calls: string[][] = []
    useDockerForRevisions(fakeDocker(images, calls))
    assert.equal(await backfillRevisionImages(), 2)
    assert.deepEqual([getRevision(tagged.id)?.registryRef, getRevision(tagged.id)?.layers], [`${GHCR}@${INDEX}`, layersFingerprint('linux', 'amd64', DIFF_IDS)])
    assert.deepEqual([getRevision(untagged.id)?.registryRef, getRevision(untagged.id)?.layers], [null, layersFingerprint('linux', 'amd64', DIFF_IDS)])
    assert.deepEqual([getRevision(moved.id)?.registryRef, getRevision(moved.id)?.layers], [null, null], "another image's reference was lent to this revision")
    assert.ok(!calls.some((args) => args.includes(catalog.imageDigest) || args.includes(`colloq-revision:${catalog.id}`)), 'a catalog reference has no local image to ask')
    // A revision that is fully known is not asked again; one that may yet be pushed is.
    calls.length = 0
    assert.equal(await backfillRevisionImages(), 0)
    assert.ok(!calls.some((args) => args.includes(`colloq-revision:${tagged.id}`)))
    assert.ok(calls.some((args) => args.includes(`colloq-revision:${untagged.id}`)))
  })
})

test('only the docker backend keeps images to inspect', async () => {
  for (const backend of ['broker', 'test']) {
    await withBackend(backend, async () => {
      revisionOf(id())
      const calls: string[][] = []
      useDockerForRevisions(fakeDocker(new Map(), calls))
      assert.equal(await backfillRevisionImages(), 0)
      assert.deepEqual(calls, [])
    })
  }
})
