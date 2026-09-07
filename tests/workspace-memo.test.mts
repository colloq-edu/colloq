/**
 * Короткая память обхода папки: за что она заведена и чего ей нельзя.
 *
 * Дерево комнаты спрашивают дважды подряд на каждую загрузку — ответ тому, кто
 * нажал, и рассылку всей комнате, — а обход стоит `readdir` плюс `lstat` на
 * каждую из двух тысяч записей, поэтому память нужна. Но в папку пишут мимо
 * `workspace.ts`: загрузка кладёт файл `rename`'ом, ячейка — из контейнера,
 * редактор сохраняет открытый файл. Память, отвечающая списком без только что
 * положенного файла, — это панель, в которой файла нет, и карточка семинара с
 * нулём файлов до следующей правки папки; оба раза врут тому самому, кто эту
 * запись и сделал.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { forgetTree, listTree, sessionDir } from '../server/src/workspace.js'

/** Положить файл так, как это делает загрузка: мимо модуля и `rename`'ом. */
function drop(room: string, rel: string, text = 'x'): void {
  const full = path.join(sessionDir(room), rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  const temp = `${full}.uploading-a1b2c3`
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, full)
}

function names(room: string): string[] {
  return listTree(room)
    .files.map((f) => f.path)
    .sort()
}

/**
 * Проба должна уложиться в окно памяти, иначе она ничего не проверяет: за его
 * пределами дерево пересчитывается и так. Триста миллисекунд на несколько
 * записей и обходов пустой папки — запас в сотни раз, и красный тест здесь
 * означает не «сломано», а «проверить не удалось».
 */
function withinWindow(startedAt: number): void {
  assert.ok(
    Date.now() - startedAt < 300,
    'проба вышла за окно памяти обхода — она ничего не доказывает',
  )
}

test('файл, положенный мимо модуля, виден сразу, а не когда истечёт память', () => {
  const room = 'memo-upload'
  const startedAt = Date.now()
  drop(room, 'handout.csv')
  assert.deepEqual(names(room), ['handout.csv'])

  drop(room, 'src/nested/model.py')
  assert.equal(fs.existsSync(path.join(sessionDir(room), 'src/nested/model.py')), true)
  assert.deepEqual(names(room), ['handout.csv', 'src', 'src/nested', 'src/nested/model.py'])
  withinWindow(startedAt)
})

test('файл в уже пройденной подпапке — тоже сразу', () => {
  const room = 'memo-nested'
  const startedAt = Date.now()
  drop(room, 'src/a.py')
  assert.deepEqual(names(room), ['src', 'src/a.py'])

  // Корень при этом не меняется: время правки двигается только у `src`.
  drop(room, 'src/b.py')
  assert.deepEqual(names(room), ['src', 'src/a.py', 'src/b.py'])
  withinWindow(startedAt)
})

test('удаление мимо модуля память тоже не переживает', () => {
  const room = 'memo-delete'
  const startedAt = Date.now()
  drop(room, 'a.txt')
  drop(room, 'b.txt')
  assert.deepEqual(names(room), ['a.txt', 'b.txt'])

  fs.unlinkSync(path.join(sessionDir(room), 'b.txt'))
  assert.deepEqual(names(room), ['a.txt'])
  withinWindow(startedAt)
})

test('пока папка не менялась, второй вопрос подряд не стоит второго обхода', () => {
  const room = 'memo-hit'
  drop(room, 'a.txt')
  const first = listTree(room)
  const second = listTree(room)
  // Тот же массив, а не равный ему: обхода не было. Ради этого память и есть.
  assert.equal(second.files, first.files)

  forgetTree(room)
  const third = listTree(room)
  assert.notEqual(third.files, first.files)
  assert.deepEqual(
    third.files.map((f) => f.path),
    first.files.map((f) => f.path),
  )
})
