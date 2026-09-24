/**
 * The non-Linux path of secure-files: no symlink may ever be FOLLOWED.
 *
 * What is checked is behaviour, not the module's text, and almost all of it on
 * any platform: on Linux a descriptor-based walk runs, on macOS a chain of
 * opens with O_NOFOLLOW, but from the outside the promise is the same. This
 * file complements workspace-fd-security.test.mts (that one is about races on
 * /proc/self/fd, Linux only) and does not repeat it.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAnchoredFilesystem } from '../server/src/secure-files.js'

const bases: string[] = []
after(() => bases.forEach(base => fs.rmSync(base, { recursive: true, force: true })))

/** The class root, a foreign directory next to it, and three ways to get out by a link:
 * as the last component (room/sub/link), the first (escape) and in the MIDDLE (room/escape). */
function fixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'colloq-nofollow-')))
  bases.push(base)
  const root = path.join(base, 'workspace'), outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, 'room/sub'), { recursive: true })
  fs.mkdirSync(path.join(outside, 'deep'), { recursive: true })
  fs.writeFileSync(path.join(root, 'room/sub/file'), 'room')
  fs.writeFileSync(path.join(outside, 'file'), 'secret')
  fs.writeFileSync(path.join(outside, 'deep/file'), 'deep secret')
  fs.symlinkSync(outside, path.join(root, 'escape'))
  fs.symlinkSync(outside, path.join(root, 'room/escape'))
  fs.symlinkSync(path.join(outside, 'file'), path.join(root, 'room/sub/link'))
  return { base, root, outside, safe: createAnchoredFilesystem(root, { allowUnsafeDevelopment: false }) }
}
/** No attempt may leave a trace in the foreign directory. */
function outsideIntact(outside: string) {
  assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'secret')
  assert.equal(fs.readFileSync(path.join(outside, 'deep/file'), 'utf8'), 'deep secret')
  assert.deepEqual(fs.readdirSync(outside).sort(), ['deep', 'file'])
  assert.deepEqual(fs.readdirSync(path.join(outside, 'deep')), ['file'])
}

test('ordinary work needs neither Linux nor the UNSAFE flag', () => {
  const { root, safe } = fixture()
  try {
    safe.mkdirSync(path.join(root, 'room/new/inner'), { recursive: true })
    safe.writeFileSync(path.join(root, 'room/new/data.txt'), 'hello')
    assert.equal(safe.readFileSync(path.join(root, 'room/new/data.txt'), 'utf8'), 'hello')
    assert.equal(safe.existsSync(path.join(root, 'room/new/data.txt')), true)
    assert.equal(safe.statSync(path.join(root, 'room/new/data.txt')).size, 5)
    assert.equal(safe.lstatSync(path.join(root, 'room/new/inner')).isDirectory(), true)
    assert.deepEqual(safe.readdirSync(path.join(root, 'room/new')).sort(), ['data.txt', 'inner'])
    assert.deepEqual(safe.readdirSync(root).sort(), ['escape', 'room'])
    safe.renameSync(path.join(root, 'room/new/data.txt'), path.join(root, 'room/new/inner/data.txt'))
    assert.equal(safe.readFileSync(path.join(root, 'room/new/inner/data.txt'), 'utf8'), 'hello')
    safe.chmodSync(path.join(root, 'room/new/inner/data.txt'), 0o640)
    assert.equal(safe.lstatSync(path.join(root, 'room/new/inner/data.txt')).mode & 0o777, 0o640)
    safe.linkSync(path.join(root, 'room/new/inner/data.txt'), path.join(root, 'room/new/copy.txt'))
    assert.equal(safe.readFileSync(path.join(root, 'room/new/copy.txt'), 'utf8'), 'hello')
    safe.unlinkSync(path.join(root, 'room/new/copy.txt'))
    safe.rmSync(path.join(root, 'room/new'), { recursive: true })
    assert.equal(safe.existsSync(path.join(root, 'room/new')), false)
    assert.equal(safe.readFileSync(path.join(root, 'room/sub/file'), 'utf8'), 'room')
  } finally { safe.close() }
})

test('a symlink as the last component is followed by neither reads nor writes', () => {
  const { root, outside, safe } = fixture()
  const link = path.join(root, 'room/sub/link')
  const before = fs.statSync(path.join(outside, 'file')).mode  // umasks differ, so compare with itself
  try {
    assert.throws(() => safe.readFileSync(link, 'utf8'))
    assert.throws(() => safe.openSync(link, 'r'))
    assert.throws(() => safe.openRead(link))
    assert.throws(() => safe.statSync(link))
    assert.throws(() => safe.createReadStream(link))
    assert.throws(() => safe.writeFileSync(link, 'overwrite'))
    assert.throws(() => safe.createWriteStream(link))
    assert.throws(() => safe.chmodSync(link, 0o777))
    // lstat and exists answer about the link itself: that is not following it.
    assert.equal(safe.lstatSync(link).isSymbolicLink(), true)
    assert.equal(safe.existsSync(link), true)
    outsideIntact(outside)
    assert.equal(fs.statSync(path.join(outside, 'file')).mode, before, 'nothing could have changed the mode of the foreign file')
  } finally { safe.close() }
})

test('no operation follows a symlink in the middle of the path', () => {
  const { root, outside, safe } = fixture()
  const through = (rest: string) => path.join(root, 'room/escape', rest)
  const attempts: Array<[string, () => unknown]> = [
    ['openSync', () => safe.openSync(through('file'), 'r')],
    ['openRead', () => safe.openRead(through('file'))],
    ['readFileSync', () => safe.readFileSync(through('file'), 'utf8')],
    ['writeFileSync', () => safe.writeFileSync(through('planted'), 'x')],
    ['statSync', () => safe.statSync(through('file'))],
    ['lstatSync', () => safe.lstatSync(through('file'))],
    ['realpathSync', () => safe.realpathSync(through('file'))],
    ['chmodSync', () => safe.chmodSync(through('file'), 0o600)],
    ['readdirSync', () => safe.readdirSync(through('deep'))],
    ['readdirSync of the link itself', () => safe.readdirSync(path.join(root, 'room/escape'))],
    ['mkdirSync', () => safe.mkdirSync(through('made'), { recursive: true })],
    ['renameSync of the source', () => safe.renameSync(through('file'), path.join(root, 'room/sub/stolen'))],
    ['renameSync of the target', () => safe.renameSync(path.join(root, 'room/sub/file'), through('planted'))],
    ['linkSync of the source', () => safe.linkSync(through('file'), path.join(root, 'room/sub/hard'))],
    ['linkSync of the target', () => safe.linkSync(path.join(root, 'room/sub/file'), through('hard'))],
    ['unlinkSync', () => safe.unlinkSync(through('file'))],
    ['rmSync', () => safe.rmSync(through('file'), { force: true })],
    ['rmSync recursive', () => safe.rmSync(through('deep'), { recursive: true, force: true })],
    ['createReadStream', () => safe.createReadStream(through('file'))],
    ['createWriteStream', () => safe.createWriteStream(through('planted'))],
  ]
  try {
    for (const [name, attempt] of attempts) assert.throws(attempt, `${name} followed a symlink in the middle of the path`)
    assert.equal(safe.existsSync(through('file')), false)
    outsideIntact(outside)
    assert.equal(fs.readFileSync(path.join(root, 'room/sub/file'), 'utf8'), 'room')
    assert.deepEqual(fs.readdirSync(path.join(root, 'room/sub')).sort(), ['file', 'link'])
  } finally { safe.close() }
})

test('deleting through a symlink leaves foreign files alone, and removes the link itself as a link', () => {
  const { root, outside, safe } = fixture()
  try {
    // Through the link: a refusal, whichever way it is called.
    assert.throws(() => safe.rmSync(path.join(root, 'escape/file'), { force: true }))
    assert.throws(() => safe.unlinkSync(path.join(root, 'escape/file')))
    assert.throws(() => safe.rmSync(path.join(root, 'escape/deep'), { recursive: true, force: true }))
    outsideIntact(outside)
    // Removing the link itself is legitimate: unlink and rmdir do not follow the
    // link, the directory entry is removed. The target has to stay in place, intact.
    safe.rmSync(path.join(root, 'room/sub/link'), { force: true })
    assert.equal(fs.existsSync(path.join(root, 'room/sub/link')), false)
    safe.unlinkSync(path.join(root, 'room/escape'))
    assert.equal(fs.existsSync(path.join(root, 'room/escape')), false)
    assert.deepEqual(fs.readdirSync(path.join(root, 'room')).sort(), ['sub'])
    outsideIntact(outside)
  } finally { safe.close() }
})

test('a recursive deletion of a room removes the links but not their targets', () => {
  const { root, outside, safe } = fixture()
  try {
    safe.rmSync(path.join(root, 'room'), { recursive: true, force: true })
    assert.equal(fs.existsSync(path.join(root, 'room')), false)
    outsideIntact(outside)
    safe.rmSync(path.join(root, 'escape'), { recursive: true, force: true })
    assert.equal(fs.lstatSync(root).isDirectory(), true)
    assert.deepEqual(fs.readdirSync(root), [])
    outsideIntact(outside)
  } finally { safe.close() }
})

test('a hard link is never made to a foreign inode', () => {
  const { root, outside, safe } = fixture()
  const target = fs.statSync(path.join(outside, 'file'))
  const made = path.join(root, 'room/sub/hard')
  try {
    // On macOS link() DOES follow a symlink source (a measurement confirmed it), so
    // there the operation has to refuse. On Linux link() copies the link itself, and
    // that is an acceptable outcome too — only one is unacceptable: a link to the
    // inode of a foreign file.
    let result: fs.Stats | undefined
    try { safe.linkSync(path.join(root, 'room/sub/link'), made); result = fs.lstatSync(made) } catch { result = undefined }
    if (process.platform !== 'linux') assert.equal(result, undefined, 'macOS has to refuse: link() would follow the link')
    if (result) assert.ok(result.isSymbolicLink() && result.ino !== target.ino, 'the hard link went to a foreign inode')
    assert.equal(fs.statSync(path.join(outside, 'file')).nlink, 1)
    outsideIntact(outside)
  } finally { safe.close() }
})

test('an open file reads from its own inode even after its name is swapped for a link', () => {
  const { root, outside, safe } = fixture()
  const file = path.join(root, 'room/sub/file')
  const opened = safe.openRead(file)
  try {
    fs.unlinkSync(file); fs.symlinkSync(path.join(outside, 'file'), file)
    assert.equal(fs.readFileSync(opened.path, 'utf8'), 'room')
  } finally { opened.close(); safe.close() }
})

test('a directory swapped between check and action is caught, and the foreign listing does not leak out',
  { skip: process.platform === 'linux' }, () => {
    const { root, outside, safe } = fixture()
    const original = fs.openSync
    let swapped = false
    // Swap the checked directory exactly in the race window: right after the
    // module opened it with O_NOFOLLOW and before readdir goes by name.
    fs.openSync = ((p: any, flags: any, mode: any) => {
      const fd = original(p, flags, mode)
      if (!swapped && String(p) === path.join(root, 'room/sub')) {
        swapped = true
        fs.renameSync(path.join(root, 'room/sub'), path.join(root, 'room/held'))
        fs.symlinkSync(outside, path.join(root, 'room/sub'))
      }
      return fd
    }) as typeof fs.openSync
    try {
      assert.throws(() => safe.readdirSync(path.join(root, 'room/sub')), /symlink|ссыл|replaced/i)
      assert.ok(swapped, 'the swap should have happened')
    } finally { fs.openSync = original; safe.close() }
  })

test('a refusal after the file was opened leaves no dangling descriptor',
  { skip: process.platform === 'linux' }, () => {
    const { root, outside, safe } = fixture()
    safe.existsSync(root)  // the root descriptor stays open for good: take it before measuring
    const original = fs.openSync
    let swapped = false
    // Swap the directory only AFTER the file is open: the module has to notice it
    // by checking the chain, refuse — and close what it opened, otherwise a
    // descriptor leaks on every such refusal.
    fs.openSync = ((p: any, flags: any, mode: any) => {
      const fd = original(p, flags, mode)
      if (!swapped && String(p) === path.join(root, 'room/sub/file')) {
        swapped = true
        fs.renameSync(path.join(root, 'room/sub'), path.join(root, 'room/held'))
        fs.symlinkSync(outside, path.join(root, 'room/sub'))
      }
      return fd
    }) as typeof fs.openSync
    const before = fs.readdirSync('/dev/fd').length
    try {
      assert.throws(() => safe.readFileSync(path.join(root, 'room/sub/file'), 'utf8'), /symlink|ссыл|replaced/i)
      assert.ok(swapped, 'the swap should have happened')
      assert.ok(fs.readdirSync('/dev/fd').length <= before, 'the open file should be closed on refusal')
    } finally { fs.openSync = original; safe.close() }
  })

test('paths outside the root and the root itself stay forbidden', () => {
  const { root, outside, base, safe } = fixture()
  try {
    assert.throws(() => safe.readFileSync(path.join(outside, 'file'), 'utf8'), /outside|вне/i)
    assert.throws(() => safe.readdirSync(path.join(base, 'outside')), /outside|вне/i)
    assert.throws(() => safe.rmSync(root, { recursive: true, force: true }))
    assert.equal(fs.existsSync(root), true)
    outsideIntact(outside)
  } finally { safe.close() }
})
