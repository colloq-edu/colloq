/**
 * The page-file store (server/src/publish/page-files.ts): one file per
 * content hash, shared by every page, removed when nothing refers to it.
 *
 * The order of writes is the whole safety story (file, then row, then the
 * page that references it), so these cases are about the moments in between:
 * a dataset reused by two pages, a republish that drops a file, a page
 * erased for good, and a crash after the copy but before the commit.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession, db } from '../server/src/db.js'
import {
  crc32,
  crc32Table,
  gcPageFiles,
  pageFileInfo,
  pageFilePath,
  pageFilesDir,
  putPageFile,
  readPageFile,
  sha256,
  sweepPageFiles,
} from '../server/src/publish/page-files.js'
import {
  deletePublication,
  listMaterials,
  writePublication,
  type StoredMaterial,
} from '../server/src/publish/store.js'

function fileMaterial(key: string, filePath: string, body: Buffer): StoredMaterial {
  const file = putPageFile(body, 'text/csv')
  return { key, kind: 'data', name: filePath, path: filePath, hash: file.hash, bytes: file.bytes }
}

const page = (sessionId: string, materials: StoredMaterial[]) =>
  writePublication({ sessionId, title: sessionId, by: 'Ада', materials, blobs: [] })

test('the CRC is the one ZIP expects, with or without zlib.crc32', () => {
  const body = Buffer.from('The quick brown fox jumps over the lazy dog')
  assert.equal(crc32(body), 0x414fa339)
  assert.equal(crc32Table(body), 0x414fa339)
  assert.equal(crc32(Buffer.alloc(0)), 0)
})

test('a dataset used by two pages is stored once', () => {
  createSession('pf-one', 'Первая', null)
  createSession('pf-two', 'Вторая', null)
  const data = Buffer.from('x,y\n1,2\n')
  const one = page('pf-one', [fileMaterial('train', 'data/train.csv', data)])
  const two = page('pf-two', [fileMaterial('train', 'train.csv', data)])
  const [a] = listMaterials(one.id)
  const [b] = listMaterials(two.id)
  assert.equal(a.hash, b.hash)
  assert.equal(a.hash, sha256(data))
  const info = pageFileInfo(a.hash)
  assert.ok(info)
  assert.equal(info.bytes, data.length)
  assert.equal(info.crc32, crc32(data))
  assert.deepEqual(readPageFile(a.hash), data)
  const rows = db.prepare('SELECT COUNT(*) AS n FROM page_files WHERE hash = ?').get(a.hash) as {
    n: number
  }
  assert.equal(rows.n, 1)
})

test('a republish that drops a file removes it; one still used elsewhere stays', () => {
  createSession('pf-again', 'Снова', null)
  createSession('pf-other', 'Соседняя', null)
  const shared = Buffer.from('shared,data\n')
  const dropped = Buffer.from('only,here\n')
  page('pf-other', [fileMaterial('shared', 'shared.csv', shared)])
  page('pf-again', [
    fileMaterial('shared', 'shared.csv', shared),
    fileMaterial('only', 'only.csv', dropped),
  ])
  assert.ok(fs.existsSync(pageFilePath(sha256(dropped))))

  const again = page('pf-again', [fileMaterial('shared', 'shared.csv', shared)])
  assert.equal(again.revision, 2)
  assert.equal(pageFileInfo(sha256(dropped)), null, 'the dropped file kept its row')
  assert.equal(fs.existsSync(pageFilePath(sha256(dropped))), false, 'the dropped file stayed on disk')
  assert.ok(pageFileInfo(sha256(shared)), 'a file another page uses was removed')
})

test('erasing a page for good takes its files with it', () => {
  createSession('pf-gone', 'Стёртая', null)
  const body = Buffer.from('erase,me\n')
  const pub = page('pf-gone', [fileMaterial('erase', 'erase.csv', body)])
  deletePublication(pub.id)
  assert.equal(pageFileInfo(sha256(body)), null)
  assert.equal(fs.existsSync(pageFilePath(sha256(body))), false)
})

test('a crash between the copy and the commit leaves neither a row nor a file behind', () => {
  // The build put its file and died before writePublication.
  const body = Buffer.from('half,built\n')
  const file = putPageFile(body, 'text/csv')
  assert.ok(pageFileInfo(file.hash))
  // The next GC (any page write, or the startup sweep) clears it.
  assert.ok(gcPageFiles() >= 1)
  assert.equal(pageFileInfo(file.hash), null)
  assert.equal(fs.existsSync(pageFilePath(file.hash)), false)
})

test('the startup sweep removes files without a row and leftover temporary names', () => {
  const stray = Buffer.from('copied, never recorded')
  const hash = sha256(stray)
  fs.mkdirSync(path.dirname(pageFilePath(hash)), { recursive: true })
  fs.writeFileSync(pageFilePath(hash), stray)
  fs.writeFileSync(`${pageFilePath(hash)}.tmp-abc123`, 'half')
  createSession('pf-kept', 'Живая', null)
  const kept = Buffer.from('still,used\n')
  page('pf-kept', [fileMaterial('kept', 'kept.csv', kept)])

  const swept = sweepPageFiles()
  assert.ok(swept.files >= 2)
  assert.equal(fs.existsSync(pageFilePath(hash)), false)
  assert.equal(fs.existsSync(`${pageFilePath(hash)}.tmp-abc123`), false)
  assert.ok(fs.existsSync(pageFilePath(sha256(kept))), 'the sweep removed a file in use')
  assert.ok(fs.readdirSync(pageFilesDir()).length > 0)
})
