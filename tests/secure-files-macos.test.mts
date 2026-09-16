/**
 * Не-Linux путь secure-files: ни один симлинк не должен быть ПРОЙДЕН.
 *
 * Проверяется поведение, а не текст модуля, и почти всё — на любой платформе:
 * на Linux работает дескрипторный обход, на macOS — цепочка открытий с
 * O_NOFOLLOW, но снаружи обещание одно и то же. Файл дополняет
 * workspace-fd-security.test.mts (тот про гонки на /proc/self/fd, только Linux)
 * и не повторяет его.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAnchoredFilesystem } from '../server/src/secure-files.js'

const bases: string[] = []
after(() => bases.forEach(base => fs.rmSync(base, { recursive: true, force: true })))

/** Корень занятия, чужой каталог рядом и три способа уйти наружу ссылкой:
 * последним звеном (room/sub/link), первым (escape) и в СЕРЕДИНЕ (room/escape). */
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
/** Ни одна попытка не имеет права оставить след в чужом каталоге. */
function outsideIntact(outside: string) {
  assert.equal(fs.readFileSync(path.join(outside, 'file'), 'utf8'), 'secret')
  assert.equal(fs.readFileSync(path.join(outside, 'deep/file'), 'utf8'), 'deep secret')
  assert.deepEqual(fs.readdirSync(outside).sort(), ['deep', 'file'])
  assert.deepEqual(fs.readdirSync(path.join(outside, 'deep')), ['file'])
}

test('обычная работа не требует ни Linux, ни флага UNSAFE', () => {
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

test('симлинк последним звеном не проходится ни чтением, ни записью', () => {
  const { root, outside, safe } = fixture()
  const link = path.join(root, 'room/sub/link')
  const before = fs.statSync(path.join(outside, 'file')).mode  // umask у всех свой, сравниваем с собой же
  try {
    assert.throws(() => safe.readFileSync(link, 'utf8'))
    assert.throws(() => safe.openSync(link, 'r'))
    assert.throws(() => safe.openRead(link))
    assert.throws(() => safe.statSync(link))
    assert.throws(() => safe.createReadStream(link))
    assert.throws(() => safe.writeFileSync(link, 'overwrite'))
    assert.throws(() => safe.createWriteStream(link))
    assert.throws(() => safe.chmodSync(link, 0o777))
    // lstat и есть-нет отвечают про саму ссылку — это не проход по ней.
    assert.equal(safe.lstatSync(link).isSymbolicLink(), true)
    assert.equal(safe.existsSync(link), true)
    outsideIntact(outside)
    assert.equal(fs.statSync(path.join(outside, 'file')).mode, before, 'права чужого файла менять было нечем')
  } finally { safe.close() }
})

test('симлинк в середине пути не проходит ни одна операция', () => {
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
    ['readdirSync самой ссылки', () => safe.readdirSync(path.join(root, 'room/escape'))],
    ['mkdirSync', () => safe.mkdirSync(through('made'), { recursive: true })],
    ['renameSync источника', () => safe.renameSync(through('file'), path.join(root, 'room/sub/stolen'))],
    ['renameSync цели', () => safe.renameSync(path.join(root, 'room/sub/file'), through('planted'))],
    ['linkSync источника', () => safe.linkSync(through('file'), path.join(root, 'room/sub/hard'))],
    ['linkSync цели', () => safe.linkSync(path.join(root, 'room/sub/file'), through('hard'))],
    ['unlinkSync', () => safe.unlinkSync(through('file'))],
    ['rmSync', () => safe.rmSync(through('file'), { force: true })],
    ['rmSync рекурсивный', () => safe.rmSync(through('deep'), { recursive: true, force: true })],
    ['createReadStream', () => safe.createReadStream(through('file'))],
    ['createWriteStream', () => safe.createWriteStream(through('planted'))],
  ]
  try {
    for (const [name, attempt] of attempts) assert.throws(attempt, `${name} прошёл по симлинку в середине пути`)
    assert.equal(safe.existsSync(through('file')), false)
    outsideIntact(outside)
    assert.equal(fs.readFileSync(path.join(root, 'room/sub/file'), 'utf8'), 'room')
    assert.deepEqual(fs.readdirSync(path.join(root, 'room/sub')).sort(), ['file', 'link'])
  } finally { safe.close() }
})

test('удаление через симлинк не трогает чужое, а саму ссылку снимает ссылкой', () => {
  const { root, outside, safe } = fixture()
  try {
    // Через ссылку — отказ, каким бы способом ни звали.
    assert.throws(() => safe.rmSync(path.join(root, 'escape/file'), { force: true }))
    assert.throws(() => safe.unlinkSync(path.join(root, 'escape/file')))
    assert.throws(() => safe.rmSync(path.join(root, 'escape/deep'), { recursive: true, force: true }))
    outsideIntact(outside)
    // Снять саму ссылку — законно: unlink и rmdir по ссылке не идут, удаляется
    // запись каталога. Цель обязана остаться на месте целой.
    safe.rmSync(path.join(root, 'room/sub/link'), { force: true })
    assert.equal(fs.existsSync(path.join(root, 'room/sub/link')), false)
    safe.unlinkSync(path.join(root, 'room/escape'))
    assert.equal(fs.existsSync(path.join(root, 'room/escape')), false)
    assert.deepEqual(fs.readdirSync(path.join(root, 'room')).sort(), ['sub'])
    outsideIntact(outside)
  } finally { safe.close() }
})

test('рекурсивное удаление комнаты снимает ссылки, но не их цели', () => {
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

test('жёсткая ссылка никогда не делается на чужой inode', () => {
  const { root, outside, safe } = fixture()
  const target = fs.statSync(path.join(outside, 'file'))
  const made = path.join(root, 'room/sub/hard')
  try {
    // На macOS link() ИДЁТ по симлинку-источнику (замер это подтвердил), поэтому
    // там операция обязана отказать. На Linux link() копирует саму ссылку, и это
    // тоже допустимый исход — недопустим один: ссылка на inode чужого файла.
    let result: fs.Stats | undefined
    try { safe.linkSync(path.join(root, 'room/sub/link'), made); result = fs.lstatSync(made) } catch { result = undefined }
    if (process.platform !== 'linux') assert.equal(result, undefined, 'macOS обязан отказать: link() пошёл бы по ссылке')
    if (result) assert.ok(result.isSymbolicLink() && result.ino !== target.ino, 'жёсткая ссылка ушла на чужой inode')
    assert.equal(fs.statSync(path.join(outside, 'file')).nlink, 1)
    outsideIntact(outside)
  } finally { safe.close() }
})

test('открытый файл читается из своего inode даже после подмены имени ссылкой', () => {
  const { root, outside, safe } = fixture()
  const file = path.join(root, 'room/sub/file')
  const opened = safe.openRead(file)
  try {
    fs.unlinkSync(file); fs.symlinkSync(path.join(outside, 'file'), file)
    assert.equal(fs.readFileSync(opened.path, 'utf8'), 'room')
  } finally { opened.close(); safe.close() }
})

test('подмена каталога между проверкой и действием ловится, чужой список наружу не уходит',
  { skip: process.platform === 'linux' }, () => {
    const { root, outside, safe } = fixture()
    const original = fs.openSync
    let swapped = false
    // Подменяем проверенный каталог ровно в окне гонки: сразу после того, как
    // модуль открыл его с O_NOFOLLOW, и до того, как readdir пойдёт по имени.
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
      assert.ok(swapped, 'подмена должна была произойти')
    } finally { fs.openSync = original; safe.close() }
  })

test('отказ после открытия файла не оставляет висящего дескриптора',
  { skip: process.platform === 'linux' }, () => {
    const { root, outside, safe } = fixture()
    safe.existsSync(root)  // корневой дескриптор объект держит открытым всегда — пусть возьмёт его до замера
    const original = fs.openSync
    let swapped = false
    // Подменяем каталог уже ПОСЛЕ того, как файл открыт: модуль обязан заметить
    // это проверкой цепочки, отказать — и закрыть открытое, иначе дескриптор
    // утечёт на каждый такой отказ.
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
      assert.ok(swapped, 'подмена должна была произойти')
      assert.ok(fs.readdirSync('/dev/fd').length <= before, 'открытый файл должен быть закрыт при отказе')
    } finally { fs.openSync = original; safe.close() }
  })

test('пути вне корня и сам корень остаются под запретом', () => {
  const { root, outside, base, safe } = fixture()
  try {
    assert.throws(() => safe.readFileSync(path.join(outside, 'file'), 'utf8'), /outside|вне/i)
    assert.throws(() => safe.readdirSync(path.join(base, 'outside')), /outside|вне/i)
    assert.throws(() => safe.rmSync(root, { recursive: true, force: true }))
    assert.equal(fs.existsSync(root), true)
    outsideIntact(outside)
  } finally { safe.close() }
})
