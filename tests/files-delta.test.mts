/**
 * Перемена в дереве вместо всего дерева — оба конца одного правила.
 *
 * Список файлов рассылался целиком на КАЖДУЮ правку папки, а правит её всё
 * подряд: автосохранение редактора, `df.to_csv` в ячейке, `pip install` в
 * терминале. Замер: один заведённый файл стоил комнате в пятьсот человек
 * 3.0 МБ — при том что изменилась одна строка из двух тысяч.
 *
 * Считает перемену сервер (workspace.ts · treeDelta), применяет вкладка
 * (web/src/lib/files-delta.ts), и разойтись им нельзя: разошедшись, они не
 * ломаются, а тихо показывают комнате чужую папку. Поэтому проверяется не
 * форма кадра, а тождество — дерево, собранное из перемен, равно дереву,
 * посчитанному обходом.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSession } from '../server/src/db.js'
import {
  deleteFile,
  forgetTree,
  listTree,
  makeDir,
  makeFile,
  movePath,
  treeDelta,
  writeText,
} from '../server/src/workspace.js'
import { applyFilesDelta } from '../web/src/lib/files-delta.js'
import type { FileEntry } from '../shared/protocol.js'

const paths = (files: readonly FileEntry[]) => files.map((entry) => entry.path)

/** Одна перемена в настоящей папке: два обхода и склейка между ними. */
function walkAround(id: string, change: () => void): { before: FileEntry[]; after: FileEntry[] } {
  const before = listTree(id).files
  change()
  /*
   * Короткая память обхода забывается ровно так же, как это делает рассылка
   * (control.ts · broadcastFiles): правка СОДЕРЖИМОГО файла не двигает время
   * папки, и без этого второй обход вернул бы прежние размеры.
   */
  forgetTree(id)
  const after = listTree(id).files
  const delta = treeDelta(before, after)
  assert.deepEqual(
    paths(applyFilesDelta(before, delta)),
    paths(after),
    'дерево, собранное из перемены, разошлось с обходом',
  )
  // И не только пути: размер с временем правки — то, по чему панель рисует
  // строку, и отстать им нельзя.
  assert.deepEqual(applyFilesDelta(before, delta), after)
  return { before, after }
}

test('заведённый файл — это одна запись в перемене, а не всё дерево', () => {
  const id = 'delta-add'
  createSession(id, 'Дельта', null)
  makeDir(id, 'src')
  makeFile(id, 'src/model.py', 'x = 1')
  makeFile(id, 'notes.md', '# заметки')

  const { before, after } = walkAround(id, () => {
    makeFile(id, 'data.csv', 'a,b\n1,2\n')
  })
  const delta = treeDelta(before, after)
  assert.deepEqual(paths(delta.added.map((one) => one.entry)), ['data.csv'])
  assert.deepEqual(delta.removed, [])
  assert.deepEqual(delta.changed, [])
  // И место у новой записи — в ГОТОВОМ списке: папки идут перед файлами, а
  // `data.csv` — перед `notes.md` по имени.
  assert.deepEqual(paths(after), ['src', 'src/model.py', 'data.csv', 'notes.md'])
  assert.equal(delta.added[0].at, 2)
})

test('удаление папки уносит всё, что в ней лежало, — одним списком путей', () => {
  const id = 'delta-remove'
  createSession(id, 'Дельта', null)
  makeDir(id, 'build')
  makeFile(id, 'build/a.txt', 'a')
  makeFile(id, 'build/b.txt', 'b')
  makeFile(id, 'model.py', 'x = 1')

  const { before, after } = walkAround(id, () => {
    deleteFile(id, 'build')
  })
  const delta = treeDelta(before, after)
  assert.deepEqual(delta.removed.sort(), ['build', 'build/a.txt', 'build/b.txt'])
  assert.deepEqual(delta.added, [])
  assert.deepEqual(paths(after), ['model.py'])
})

test('переименование — это ушедшая запись и пришедшая, и порядок сходится', () => {
  const id = 'delta-move'
  createSession(id, 'Дельта', null)
  makeFile(id, 'alpha.py', 'x = 1')
  makeFile(id, 'omega.py', 'y = 2')

  const { before, after } = walkAround(id, () => {
    movePath(id, 'alpha.py', 'zulu.py')
  })
  const delta = treeDelta(before, after)
  assert.deepEqual(delta.removed, ['alpha.py'])
  assert.deepEqual(paths(delta.added.map((one) => one.entry)), ['zulu.py'])
  // Переехавшая запись встала в конец — и вставка по месту в ГОТОВОМ списке
  // это воспроизвела, хотя удаление сдвинуло всё, что было после неё.
  assert.deepEqual(paths(after), ['omega.py', 'zulu.py'])
})

test('переписанный файл едет размером и временем, а не заново всей папкой', () => {
  const id = 'delta-write'
  createSession(id, 'Дельта', null)
  makeFile(id, 'model.py', 'x = 1')
  makeFile(id, 'notes.md', '# заметки')

  const { before, after } = walkAround(id, () => {
    writeText(id, 'model.py', 'x = 1\ny = 2\nz = 3\n')
  })
  const delta = treeDelta(before, after)
  assert.deepEqual(delta.added, [])
  assert.deepEqual(delta.removed, [])
  assert.deepEqual(paths(delta.changed), ['model.py'])
  assert.equal(delta.changed[0].size, after[0].size)
})

test('пустая перемена — пустая: совпавший обход не рассказывает ничего', () => {
  const id = 'delta-same'
  createSession(id, 'Дельта', null)
  makeFile(id, 'model.py', 'x = 1')
  const tree = listTree(id).files
  assert.deepEqual(treeDelta(tree, tree), { removed: [], changed: [], added: [] })
  assert.deepEqual(applyFilesDelta(tree, treeDelta(tree, tree)), tree)
})

/* ----------------------------------------------------- склейка без папки */

const entry = (path: string, size = 1): FileEntry => ({
  name: path.split('/').at(-1) ?? path,
  path,
  dir: false,
  size,
  modifiedAt: 1,
})

test('любая пара списков склеивается обратно в себя', () => {
  /*
   * Порядок дерева однозначно определён его составом, поэтому уцелевшие записи
   * стоят друг относительно друга одинаково в обоих списках, — на этом и стоит
   * вставка по месту. Здесь это проверяется не рассуждением, а перебором: все
   * подмножества десяти имён, попарно.
   */
  const all = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
  const pick = (mask: number) => all.filter((_, i) => (mask >> i) & 1).map((name) => entry(name))
  for (const from of [0, 1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 682, 341]) {
    for (const to of [0, 1, 5, 21, 85, 341, 682, 1023, 512, 255]) {
      const before = pick(from)
      const after = pick(to)
      assert.deepEqual(
        applyFilesDelta(before, treeDelta(before, after)),
        after,
        `${from} → ${to}: склейка разошлась со списком`,
      )
    }
  }
})

test('перемена, разошедшаяся со списком, не роняет панель', () => {
  // Последняя черта: разрыв номеров ловится раньше (session.svelte.ts), но
  // упасть на кадре из сети вкладка не вправе ни при каком его содержимом.
  const files = [entry('a'), entry('b')]
  const wild = applyFilesDelta(files, {
    removed: ['нет такого'],
    changed: [entry('тоже нет')],
    added: [{ at: 99, entry: entry('c') }],
  })
  assert.deepEqual(paths(wild), ['a', 'b', 'c'])
})

/* ------------------------------------------------- разбор во вкладке */

/** Исходник без комментариев: объяснение — не обещание. */
function code(rel: string): string {
  return fs
    .readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}

test('вкладка склеивает перемену только со своим номером, иначе спрашивает дерево', () => {
  /*
   * Разбор живёт в рунном классе, и без браузера его не позвать — обещания
   * сняты с исходника, ровно как в weblib-reconnect-storm. Проверяется не
   * форма кода, а три вещи, без которых панель тихо покажет чужую папку:
   * номер запоминается с полным списком, перемена не той родословной не
   * применяется вовсе, и вместо догадки задаётся вопрос.
   */
  const session = code('web/src/lib/session.svelte.ts')
  const from = session.indexOf("message.t === 'files:delta'")
  assert.notEqual(from, -1, 'кадр перемены вкладка не разбирает вовсе')
  const branch = session.slice(from, session.indexOf('} else if (message.t', from + 1))

  assert.match(branch, /this\.#filesRev !== message\.from/, 'перемена ложится на любой список')
  assert.match(branch, /this\.send\(\{ t: 'files:ask' \}\)/, 'разрыв номеров лечится молчанием')
  assert.match(branch, /applyFilesDelta\(this\.files, message\)/, 'склейка своя, а не общая')
  assert.match(branch, /this\.#filesRev = message\.rev/, 'номер после склейки не сдвинулся')
  // И полный список по-прежнему запоминает свой номер: без этого первая же
  // перемена не подойдёт ни к чему.
  const full = session.slice(session.indexOf("message.t === 'files'"))
  assert.match(full.slice(0, 400), /this\.#filesRev = message\.rev \?\? 0/)
})
