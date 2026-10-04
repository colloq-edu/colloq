/**
 * «Скачать всё» on a competition's task tab: one archive of the open files.
 *
 * What it must never do is let out what the single-file door keeps in: the
 * hidden answers and a sealed test, even one named like an open example. And
 * the archive must unpack the way a submission sees the files — `data/` with
 * the starter notebook beside it — with every CRC right, or the class gets a
 * ZIP that will not open.
 */
import './_env.mts'
import http from 'node:http'
import zlib from 'node:zlib'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCompetition, getCompetition, putFile, setCompetitionState } from '../server/src/competitions/store.js'
import { ensureCompetition, putOpenFile, putSealedFile, putSecretFile } from '../server/src/competitions/storage.js'
import { archivedName } from '../server/src/competitions/zip.js'
import { app } from '../server/src/app.js'

let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
after(() => server?.close())

const bytes = (text: string) => new TextEncoder().encode(text)

function competition(slug: string) {
  const made = createCompetition({
    slug,
    title: slug,
    metric: { name: 'ROC AUC', direction: 'higher', code: 'def score(solution, submission):\n    return 0.5\n' },
    deadlineAt: Date.now() + 3_600_000,
  })
  assert.ok(made)
  setCompetitionState(made.id, 'live')
  ensureCompetition(made.id)
  const open = (name: string, body: string) => {
    putOpenFile(made.id, name, bytes(body))
    putFile({ competitionId: made.id, name, bytes: body.length, rows: null, visibility: 'open' })
  }
  open('train.csv', 'id,x,y\n1,0.5,1\n2,0.25,0\n')
  open('test.csv', 'id,x\n3,0.75\n')
  open('start.ipynb', '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}')
  putSecretFile(made.id, 'solution.csv', bytes('id,y\n3,1\n'))
  putFile({ competitionId: made.id, name: 'solution.csv', bytes: 9, rows: 1, visibility: 'hidden' })
  // A sealed test under the open example's name: the archive keeps the example.
  putSealedFile(made.id, 'test.csv', bytes('id,x\nSECRET,1\n'))
  putFile({ competitionId: made.id, name: 'test.csv', bytes: 15, rows: 1, visibility: 'sealed' })
  return getCompetition(made.id)!
}

/** Every stored entry of an archive, read from its local headers, with its CRC checked. */
function entries(zip: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  let at = 0
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const crc = zip.readUInt32LE(at + 14)
    const size = zip.readUInt32LE(at + 18)
    const nameLength = zip.readUInt16LE(at + 26)
    const extra = zip.readUInt16LE(at + 28)
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8')
    const body = zip.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + size)
    assert.equal(zlib.crc32(body) >>> 0, crc, `${name}: the CRC in the header is the body's`)
    out.set(name, body.toString('utf8'))
    at += 30 + nameLength + extra + size
  }
  assert.equal(zip.readUInt32LE(at), 0x02014b50, 'the central directory follows the last file')
  return out
}

test('the archive holds the open files as a submission sees them, and nothing hidden', async () => {
  competition('zip-all')
  const res = await fetch(`${base}/api/k/competitions/zip-all/files.zip`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/zip')
  assert.match(res.headers.get('content-disposition') ?? '', /zip-all\.zip/)
  const zip = Buffer.from(await res.arrayBuffer())
  assert.equal(Number(res.headers.get('content-length')), zip.length, 'the length promised is the length sent')
  const files = entries(zip)
  assert.deepEqual([...files.keys()].sort(), ['zip-all/data/test.csv', 'zip-all/data/train.csv', 'zip-all/start.ipynb'])
  assert.equal(files.get('zip-all/data/test.csv'), 'id,x\n3,0.75\n', 'the example, never the sealed test')
  assert.doesNotMatch(zip.toString('latin1'), /SECRET|solution/)
  // A second download reads the remembered CRCs and is byte for byte the same.
  const again = Buffer.from(await (await fetch(`${base}/api/k/competitions/zip-all/files.zip`)).arrayBuffer())
  assert.ok(again.equals(zip))
})

test('a notebook goes next to data/, every other file inside it', () => {
  assert.equal(archivedName('baseline.ipynb'), 'baseline.ipynb')
  assert.equal(archivedName('Start.IPYNB'), 'Start.IPYNB')
  assert.equal(archivedName('images.zip'), 'data/images.zip')
  assert.equal(archivedName('train.parquet'), 'data/train.parquet')
})

test('a draft or a missing competition has no archive', async () => {
  const draft = createCompetition({ slug: 'zip-draft', title: 'zip-draft', metric: { name: 'AUC', direction: 'higher', code: '' } })
  assert.ok(draft)
  assert.equal((await fetch(`${base}/api/k/competitions/zip-draft/files.zip`)).status, 404)
  assert.equal((await fetch(`${base}/api/k/competitions/nope/files.zip`)).status, 404)
})
