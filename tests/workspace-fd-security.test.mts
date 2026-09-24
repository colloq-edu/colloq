import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAnchoredFilesystem } from '../server/src/secure-files.js'

const roots: string[] = []
after(() => roots.forEach(root => fs.rmSync(root, { recursive: true, force: true })))
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-fd-')); roots.push(base)
  const root = path.join(base, 'workspace'), outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, 'room/sub'), { recursive: true }); fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, 'room/sub/file'), 'room'); fs.writeFileSync(path.join(outside, 'file'), 'secret')
  return { root, outside, safe: createAnchoredFilesystem(root, { allowUnsafeDevelopment: false }) }
}
const linux = process.platform === 'linux'
/*
 * This vow used to say the opposite: "outside Linux we refuse rather than
 * quietly substitute a fallback path", and on macOS the files panel did not
 * work at all without `COLLOQ_UNSAFE_DEV_FILES=1` in .env.
 *
 * The word UNSAFE is gone from the teacher's path: a class on a laptop is
 * installed via pip and started with one command, and the first thing a
 * person with a MacBook saw was a demand to type in by hand a flag that
 * promises insecurity. Instead of the flag the secure layer got a working
 * path: every segment is opened with O_NOFOLLOW, so a symlink CANNOT GET
 * THROUGH either as the last link or in the middle — and what exactly remains
 * on macOS (a directory-swap race: there is nothing to address relative to a
 * descriptor with, Node has no openat) is stated in the header of
 * secure-files.ts and checked in secure-files-macos.test.mts.
 *
 * What remains here is the half that is checked with one line: it works
 * without any flag.
 */
test('outside Linux the walk works without the flag too', { skip: linux }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-fd-')); roots.push(root)
  assert.deepEqual(createAnchoredFilesystem(root, { allowUnsafeDevelopment: false }).readdirSync(root), [])
})
test('opened parent remains confined after a deterministic parent symlink swap', { skip: !linux }, () => {
  const { root, outside, safe } = fixture(); const original = fs.openSync; let swapped = false
  fs.openSync = ((p: any, flags: any, mode: any) => {
    const fd = original(p, flags, mode)
    if (!swapped && String(p).endsWith('/sub') && String(p).startsWith('/proc/self/fd/')) {
      swapped = true; fs.renameSync(path.join(root, 'room/sub'), path.join(root, 'room/held')); fs.symlinkSync(outside, path.join(root, 'room/sub'))
    }
    return fd
  }) as typeof fs.openSync
  try { assert.equal(safe.readFileSync(path.join(root, 'room/sub/file'), 'utf8'), 'room'); assert.ok(swapped) }
  finally { fs.openSync = original; safe.close() }
})
test('final symlink swap is refused and cannot read or truncate the target', { skip: !linux }, () => {
  const { root, outside, safe } = fixture(); const original = fs.openSync; let swapped = false
  fs.openSync = ((p: any, flags: any, mode: any) => {
    if (!swapped && String(p).endsWith('/file') && String(p).startsWith('/proc/self/fd/')) {
      swapped = true; fs.unlinkSync(path.join(root, 'room/sub/file')); fs.symlinkSync(path.join(outside, 'file'), path.join(root, 'room/sub/file'))
    }
    return original(p, flags, mode)
  }) as typeof fs.openSync
  try { assert.throws(() => safe.writeFileSync(path.join(root, 'room/sub/file'), 'overwrite')); assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'secret') }
  finally { fs.openSync = original; safe.close() }
})
test('recursive removal does not follow a child directory swapped into a symlink', { skip: !linux }, () => {
  const { root, outside, safe } = fixture(); const original = fs.openSync; let swapped = false
  fs.openSync = ((p: any, flags: any, mode: any) => {
    if (!swapped && String(p).endsWith('/sub') && String(p).startsWith('/proc/self/fd/')) {
      swapped = true; fs.renameSync(path.join(root, 'room/sub'), path.join(root, 'held')); fs.symlinkSync(outside, path.join(root, 'room/sub'))
    }
    return original(p, flags, mode)
  }) as typeof fs.openSync
  try { try { safe.rmSync(path.join(root, 'room'), { recursive: true, force: true }) } catch {} assert.ok(swapped); assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'secret') }
  finally { fs.openSync = original; safe.close() }
})
test('held read descriptor survives replacement and paths outside the root are refused', { skip: !linux }, () => {
  const { root, outside, safe } = fixture(); const opened = safe.openRead(path.join(root, 'room/sub/file'))
  fs.unlinkSync(path.join(root, 'room/sub/file')); fs.symlinkSync(path.join(outside, 'file'), path.join(root, 'room/sub/file'))
  try { assert.equal(fs.readFileSync(opened.path, 'utf8'), 'room'); assert.throws(() => safe.readFileSync(path.join(outside, 'file'), 'utf8'), /outside|вне workspace/); assert.throws(() => safe.mkdirSync(path.join(root, 'room/sub/file/new'), { recursive: true })) }
  finally { opened.close(); safe.close() }
})
test('create and rename keep both parents anchored across replacement', { skip: !linux }, () => {
  const { root, outside, safe } = fixture(); const original = fs.openSync; let swapped = false
  fs.openSync = ((p: any, flags: any, mode: any) => {
    const fd = original(p, flags, mode)
    if (!swapped && String(p).endsWith('/sub') && String(p).startsWith('/proc/self/fd/')) {
      swapped = true; fs.renameSync(path.join(root, 'room/sub'), path.join(root, 'room/held')); fs.symlinkSync(outside, path.join(root, 'room/sub'))
    }
    return fd
  }) as typeof fs.openSync
  try {
    safe.writeFileSync(path.join(root, 'room/sub/new'), 'confined', { flag: 'wx' })
    assert.equal(fs.readFileSync(path.join(root, 'room/held/new'), 'utf8'), 'confined')
    assert.ok(!fs.existsSync(path.join(outside, 'new')))
    assert.throws(() => safe.renameSync(path.join(root, 'room/held/new'), path.join(root, 'room/sub/file')))
    assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'secret')
  } finally { fs.openSync = original; safe.close() }
})
test('rename writes into the already-opened destination directory after its name is swapped', { skip: !linux }, () => {
  const { root, outside, safe } = fixture(); fs.mkdirSync(path.join(root, 'room/to'))
  const original = fs.openSync; let swapped = false
  fs.openSync = ((p: any, flags: any, mode: any) => {
    const fd = original(p, flags, mode)
    if (!swapped && String(p).endsWith('/to') && String(p).startsWith('/proc/self/fd/')) {
      swapped = true; fs.renameSync(path.join(root, 'room/to'), path.join(root, 'room/destination-held')); fs.symlinkSync(outside, path.join(root, 'room/to'))
    }
    return fd
  }) as typeof fs.openSync
  try {
    safe.renameSync(path.join(root, 'room/sub/file'), path.join(root, 'room/to/file'))
    assert.ok(swapped); assert.equal(fs.readFileSync(path.join(root, 'room/destination-held/file'), 'utf8'), 'room')
    assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'secret')
  } finally { fs.openSync = original; safe.close() }
})
test('non-root recursive removal recovers owned directories with mode000', { skip: !linux || process.getuid?.() === 0 }, () => {
  const { root, safe } = fixture()
  fs.chmodSync(path.join(root, 'room/sub'), 0); fs.chmodSync(path.join(root, 'room'), 0)
  try {
    safe.rmSync(path.join(root, 'room'), { recursive: true, force: true })
    assert.ok(!fs.existsSync(path.join(root, 'room')))
  } finally {
    try { fs.chmodSync(path.join(root, 'room'), 0o700); fs.chmodSync(path.join(root, 'room/sub'), 0o700) } catch {}
    safe.close()
  }
})
test('non-root removal can traverse an owned locked parent without following replacement symlinks', { skip: !linux || process.getuid?.() === 0 }, () => {
  const { root, outside, safe } = fixture()
  fs.chmodSync(path.join(root, 'room/sub'), 0)
  try {
    safe.rmSync(path.join(root, 'room/sub/file'), { force: true })
    assert.ok(!fs.existsSync(path.join(root, 'room/sub/file')))
    fs.rmdirSync(path.join(root, 'room/sub')); fs.symlinkSync(outside, path.join(root, 'room/sub'))
    assert.throws(() => safe.rmSync(path.join(root, 'room/sub/file'), { force: true }))
    assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'secret')
  } finally {
    try { if (!fs.lstatSync(path.join(root, 'room/sub')).isSymbolicLink()) fs.chmodSync(path.join(root, 'room/sub'), 0o700) } catch {}
    safe.close()
  }
})
test('permission recovery changes only the pinned directory after a name-to-symlink swap', { skip: !linux || process.getuid?.() === 0 }, () => {
  const { root, outside, safe } = fixture()
  fs.chmodSync(path.join(root, 'room/sub'), 0); fs.chmodSync(outside, 0o500)
  const original = fs.openSync; let swapped = false
  fs.openSync = ((p: any, flags: any, mode: any) => {
    const fd = original(p, flags, mode)
    if (!swapped && String(p).endsWith('/sub') && String(p).startsWith('/proc/self/fd/')) {
      swapped = true; fs.renameSync(path.join(root, 'room/sub'), path.join(root, 'room/held')); fs.symlinkSync(outside, path.join(root, 'room/sub'))
    }
    return fd
  }) as typeof fs.openSync
  try {
    assert.throws(() => safe.rmSync(path.join(root, 'room'), { recursive: true, force: true }))
    assert.ok(swapped)
    assert.equal(fs.statSync(outside).mode & 0o777, 0o500, 'outside inode must not be chmodded through the swapped name')
    assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'secret')
    assert.equal(fs.statSync(path.join(root, 'room/held')).mode & 0o700, 0o700)
  } finally { fs.openSync = original; fs.chmodSync(outside, 0o700); safe.close() }
})
