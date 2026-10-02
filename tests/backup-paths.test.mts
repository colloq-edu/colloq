/**
 * Class-page files are in the backup, and the restore lets them back in.
 *
 * The database names page files only by hash (publish/page-files.ts); a
 * backup of colloq.db without data/page-files restores every class page with
 * downloads that 404. backup-local.sh packs an explicit list, and restore.sh
 * refuses any name outside its own list, so both have to know the folder:
 * forgetting it in the second turns every new backup into one that cannot be
 * restored at all.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

test('backup-local.sh packs data/page-files with the other class files', () => {
  const script = read('scripts/backup-local.sh')
  const list = script.split('\n').find((line) => /^for p in workspace /.test(line))
  assert.ok(list, 'the list of packed paths moved; update this test')
  assert.match(list, /\bdata\/page-files\b/)
  assert.match(list, /\bdata\/blobs\b/)
})

test('restore.sh accepts data/page-files from an archive', () => {
  const script = read('scripts/restore.sh')
  const allowed = script.split('\n').find((line) => line.includes('name ~ /^data\\/('))
  assert.ok(allowed, 'the allowlist of archive names moved; update this test')
  const pattern = /\^data\\\/\(([^)]*)\)/.exec(allowed)
  assert.ok(pattern, allowed)
  assert.ok(pattern[1].split('|').includes('page-files'), allowed)
  assert.ok(pattern[1].split('|').includes('blobs'), allowed)
})
