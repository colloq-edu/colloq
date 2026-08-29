/**
 * Папка семинара перестала быть плоской, и каждая строка здесь — попытка из неё
 * выйти или положить в неё то, что потом не покажут.
 *
 * Проверка одна на двоих: браузер зовёт её, чтобы отказать раньше сети, сервер —
 * чтобы отказать по существу. Разойдясь, они дают худший вид ошибки: панель
 * уверена, что имя годится, а сервер молча его не принимает.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  MAX_DEPTH,
  baseOf,
  extOf,
  highlightFor,
  kindOf,
  normalizePath,
  parentOf,
  runnerFor,
  safeSegment,
} from '../shared/paths.js'
import { createSession } from '../server/src/db.js'
import {
  listFiles,
  makeDir,
  makeFile,
  movePath,
  readText,
  resolveInSession,
  sessionDir,
  writeText,
} from '../server/src/workspace.js'

test('путь наружу не превращается в путь внутрь', () => {
  for (const raw of [
    '../secret',
    '../../etc/passwd',
    'src/../../out',
    '/etc/passwd',
    '/',
    './../x',
    'a/./b',
    'a/../b',
    'src/..',
  ]) {
    assert.equal(normalizePath(raw), null, raw)
  }
})

test('абсолютный путь отвергается, а не срезается до относительного', () => {
  // Срезать было бы безопасно и нечестно: человек имел в виду файл на машине,
  // а получил бы новую папку `etc` внутри семинара и пустоту в ней.
  assert.equal(normalizePath('/data/train.csv'), null)
  assert.equal(normalizePath('data/train.csv'), 'data/train.csv')
})

test('лишние разделители убираются, а имена — нет', () => {
  assert.equal(normalizePath('src//model.py'), 'src/model.py')
  assert.equal(normalizePath('src/model.py/'), 'src/model.py')
  assert.equal(normalizePath('данные/пример данных.csv'), 'данные/пример данных.csv')
  assert.equal(normalizePath(''), '', 'корень — это пустая строка, а не отказ')
})

test('глубже потолка не пускают', () => {
  const ok = Array.from({ length: MAX_DEPTH }, (_, i) => `d${i}`).join('/')
  assert.equal(normalizePath(ok), ok)
  assert.equal(normalizePath(`${ok}/one-too-deep`), null)
})

test('скрытое имя отвергается, а не принимается и прячется', () => {
  for (const name of ['.env', '.git', '.ipynb_checkpoints']) {
    assert.equal(safeSegment(name), false, name)
    assert.equal(normalizePath(`src/${name}`), null, name)
  }
})

test('пробел с краю не проходит: такое имя потом не набрать', () => {
  assert.equal(safeSegment('model.py '), false)
  assert.equal(safeSegment(' model.py'), false)
  assert.equal(safeSegment('my model.py'), true)
})

test('разбор пути на части', () => {
  assert.equal(parentOf('src/deep/model.py'), 'src/deep')
  assert.equal(parentOf('model.py'), '')
  assert.equal(baseOf('src/model.py'), 'model.py')
  assert.equal(extOf('src/model.PY'), 'py')
  assert.equal(extOf('Makefile'), '')
  assert.equal(extOf('.hidden'), '', 'точка в начале — не расширение')
})

test('чем файл окажется на экране', () => {
  assert.equal(kindOf('train.py'), 'text')
  assert.equal(kindOf('data/train.csv'), 'text')
  assert.equal(kindOf('lecture.pdf'), 'pdf')
  assert.equal(kindOf('plot.png'), 'image')
  assert.equal(kindOf('seminar.ipynb'), 'notebook', 'тетрадь не правят как JSON')
  assert.equal(kindOf('model.pkl'), 'binary')
  assert.equal(kindOf('Makefile'), 'text')
})

test('запускается только то, чем есть что запустить', () => {
  assert.equal(runnerFor('train.py'), 'python')
  assert.equal(runnerFor('setup.sh'), 'shell')
  assert.equal(runnerFor('data.csv'), null)
  assert.equal(runnerFor('seminar.ipynb'), null, 'тетрадь запускают ячейками')
})

test('подсветка по расширению, и молчание там, где грамматики нет', () => {
  assert.equal(highlightFor('train.py'), 'python')
  assert.equal(highlightFor('README.md'), 'markdown')
  assert.equal(highlightFor('data.csv'), null)
})

/* ---------------------------------------------------- дерево на диске */

const ROOM = 'tree-room'

test('дерево читается в том порядке, в каком его рисуют', () => {
  createSession(ROOM, 'Tree', null)
  const root = sessionDir(ROOM)
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n')
  fs.writeFileSync(path.join(root, 'src', 'model.py'), 'x = 1\n')
  fs.writeFileSync(path.join(root, 'data', 'train.csv'), 'a,b\n')

  const listed = listFiles(ROOM).map((entry) => `${entry.dir ? 'd ' : 'f '}${entry.path}`)
  assert.deepEqual(listed, ['d data', 'f data/train.csv', 'd src', 'f src/model.py', 'f README.md'])
})

test('имя файла и его путь — разные поля, и в корне они совпадают', () => {
  const listed = listFiles(ROOM)
  const nested = listed.find((entry) => entry.path === 'src/model.py')
  assert.equal(nested?.name, 'model.py')
  const root = listed.find((entry) => entry.path === 'README.md')
  assert.equal(root?.name, root?.path, 'у файла в корне path и name — одно и то же')
})

test('символическая ссылка на папку снаружи не становится папкой комнаты', () => {
  // Ячейка выполняет любой Python в той же папке: `os.symlink('/', 'all')` —
  // одна строка. Обход по lstat отказывает ей и как файлу, и как папке.
  const root = sessionDir(ROOM)
  const outside = fs.mkdtempSync(path.join(root, '..', 'outside-'))
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'ключ')
  const link = path.join(root, 'elsewhere')
  fs.symlinkSync(outside, link)
  try {
    const listed = listFiles(ROOM).map((entry) => entry.path)
    assert.ok(!listed.includes('elsewhere'), 'ссылка на чужую папку попала в дерево')
    assert.ok(!listed.some((p) => p.startsWith('elsewhere/')), 'через ссылку прочитали чужое')
    assert.equal(resolveInSession(ROOM, 'elsewhere/secret.txt'), null)
  } finally {
    fs.unlinkSync(link)
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('новый файл не ложится поверх существующего', () => {
  assert.equal(makeFile(ROOM, 'src/model.py'), 'exists')
  assert.equal(readText(ROOM, 'src/model.py')?.text, 'x = 1\n', 'файл всё-таки переписали')
  assert.equal(makeFile(ROOM, 'src/other.py', 'y = 2\n'), 'ok')
  assert.equal(readText(ROOM, 'src/other.py')?.text, 'y = 2\n')
})

test('папку нельзя переложить внутрь самой себя', () => {
  assert.equal(makeDir(ROOM, 'src/deep'), 'ok')
  assert.equal(movePath(ROOM, 'src', 'src/deep/src'), 'bad-name')
  assert.ok(readText(ROOM, 'src/model.py'), 'поддерево уехало из дерева')
})

test('переименование переносит и содержимое, и путь', () => {
  assert.equal(movePath(ROOM, 'src/other.py', 'src/renamed.py'), 'ok')
  assert.equal(readText(ROOM, 'src/renamed.py')?.text, 'y = 2\n')
  assert.equal(readText(ROOM, 'src/other.py'), null)
})

test('двоичный файл не открывается как текст', () => {
  const root = sessionDir(ROOM)
  fs.writeFileSync(path.join(root, 'model.pkl'), Buffer.from([0x80, 0x04, 0x00, 0x95, 0x01]))
  const read = readText(ROOM, 'model.pkl')
  assert.equal(read?.binary, true)
  assert.equal(read?.text, '', 'мусор попал бы в редактор и предложил бы себя сохранить')
})

test('запись идёт рядом и переименованием, а не поверх', () => {
  // Тот же довод, что и у загрузки: `writeFileSync` сначала обрезает файл до
  // нуля, и ячейка, читающая его в этот момент, дочитывает половину без ошибки.
  writeText(ROOM, 'data/train.csv', 'a,b\n1,2\n')
  assert.equal(readText(ROOM, 'data/train.csv')?.text, 'a,b\n1,2\n')
  const leftovers = fs
    .readdirSync(path.join(sessionDir(ROOM), 'data'))
    .filter((n) => n.startsWith('.'))
  assert.deepEqual(leftovers, [], 'временный файл остался лежать рядом')
})
