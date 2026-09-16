/**
 * Картинка заметки, лежащая ФАЙЛОМ в папке семинара.
 *
 * Третий способ положить картинку в текстовую ячейку — и до сих пор
 * единственный, который не работал нигде. Два первых (`data:` в тексте и
 * вложение nbformat) приезжают из .ipynb и уходят на полку; этот из файла
 * тетради не приезжает вовсе — там лежит путь к соседнему файлу, который
 * Jupyter читает с диска.
 *
 * В комнате такой путь оставался как написан, и браузер разрешал его от адреса
 * страницы: `/s/<комната>/assets/fig01.png`. Там стоит приложение, и на любой
 * путь оно отвечает своим index.html — 200 и `text/html`. Картинки нет, и в
 * сети даже не 404: успех, который нечем показать.
 *
 * Здесь проверяется разбор — половина, общая браузеру и серверу, — и то, что
 * публикация забирает файл с собой: папка семинара живёт ровно столько, сколько
 * живёт комната, а страницу открывают в среду вечером.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { findWorkspaceImages, workspacePathOf } from '../shared/images.js'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, releaseSessionDoc } from '../server/src/collab/index.js'
import { makeDir, readBytes, sessionDir } from '../server/src/workspace.js'
import { newBlobBag, pageOfDoc } from '../server/src/publish/build.js'
import { createCell, getCells } from '../shared/notebook.js'

/** Настоящий PNG: восемь байт заголовка и немного после них. */
function png(seed = 1): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([head, Buffer.alloc(2048, seed)])
}

/** Заметка, добавленная тестом: у новой комнаты первой лежит приветственная. */
function addedNote(doc: Y.Doc): string {
  const bag = newBlobBag()
  const cells = pageOfDoc(doc, bag)
  return cells[cells.length - 1].source
}

/** Комната с картинкой в папке и одной заметкой, которая на неё ссылается. */
function roomWith(id: string, note: string, files: Record<string, Buffer>): Y.Doc {
  createSession(id, 'Лекция', null)
  makeDir(id, 'assets')
  for (const [rel, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(sessionDir(id), rel), body)
  }
  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    getCells(doc).push([createCell('markdown', note)])
  })
  return doc
}

/** Пути, найденные в тексте. */
const paths = (source: string): string[] => findWorkspaceImages(source).map((ref) => ref.path)

/** Текст с подставленным адресом — так, как это делает заметка. */
function substituted(source: string, url: string): string {
  let out = source
  for (const ref of [...findWorkspaceImages(source)].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, ref.start) + url + out.slice(ref.end)
  }
  return out
}

test('путь к соседнему файлу находится в обеих записях картинки', () => {
  assert.deepEqual(paths('![Четыре вопроса](assets/fig01_four_questions.png)'), [
    'assets/fig01_four_questions.png',
  ])
  assert.deepEqual(paths('<img src="assets/fig01.png" alt="схема">'), ['assets/fig01.png'])
  assert.deepEqual(paths("<img alt='схема' src='assets/fig01.png'>"), ['assets/fig01.png'])
  assert.deepEqual(paths('<img src=assets/fig01.png>'), ['assets/fig01.png'])
})

test('заменяется адрес, а не подпись', () => {
  // `![assets/x.png](assets/x.png)` — поиск подстроки нашёл бы первое вхождение,
  // то есть подпись. Отсюда счёт от длины того, что стоит ПЕРЕД путём.
  assert.equal(
    substituted('![assets/x.png](assets/x.png)', 'URL'),
    '![assets/x.png](URL)',
  )
})

test('«та же папка, записанная иначе» — это та же папка', () => {
  assert.deepEqual(paths('![схема](./assets/fig01.png)'), ['assets/fig01.png'])
  assert.deepEqual(paths('![схема](assets//fig01.png)'), ['assets/fig01.png'])
  // Пробел в имени markdown пишет как %20, а атрибут — пробелом.
  assert.deepEqual(paths('![схема](assets/my%20fig.png)'), ['assets/my fig.png'])
  assert.deepEqual(paths('<img src="assets/my fig.png">'), ['assets/my fig.png'])
})

test('за папку семинара выйти нечем', () => {
  assert.deepEqual(paths('![x](../../etc/passwd)'), [])
  assert.deepEqual(paths('![x](/etc/passwd)'), [])
  assert.deepEqual(paths('![x](assets/../../secret)'), [])
  assert.equal(workspacePathOf('..'), null)
  assert.equal(workspacePathOf('/api/sessions/x/file'), null)
})

test('то, за чем идут не к нам, не трогается', () => {
  // Полка комнаты, внешний адрес, картинка содержимым и якорь: у каждого свой
  // путь через заметку, и подменять их файлом из папки нельзя.
  assert.deepEqual(paths('![x](attachment:abc123.png)'), [])
  assert.deepEqual(paths('![x](https://example.com/a.png)'), [])
  assert.deepEqual(paths('![x](//example.com/a.png)'), [])
  assert.deepEqual(paths('![x](data:image/png;base64,AAAA)'), [])
  assert.deepEqual(paths('<img src="#anchor">'), [])
})

test('ссылка — не картинка', () => {
  // `[текст](assets/x.png)` без восклицательного знака — это ссылка, и билет
  // на файл ей не выдаётся: у скачивания свой путь через панель файлов.
  assert.deepEqual(paths('[данные](data/train.csv)'), [])
})

test('несколько картинок в одной заметке — все', () => {
  const source = [
    '# Лекция',
    '![один](assets/fig01.png)',
    'текст',
    '<img src="assets/fig03.png">',
    '![два](./assets/fig04.png)',
  ].join('\n\n')
  assert.deepEqual(paths(source), ['assets/fig01.png', 'assets/fig04.png', 'assets/fig03.png'])
})

test('публикация забирает картинку из папки с собой', () => {
  // Папка семинара живёт ровно столько, сколько живёт комната, а страницу
  // открывают в среду вечером: путь `assets/fig01.png` на ней — мёртвая ссылка.
  const body = png(7)
  const doc = roomWith(
    'note-ws-publish',
    '![схема](assets/fig01.png)',
    { 'assets/fig01.png': body },
  )
  const bag = newBlobBag()
  const cells = pageOfDoc(doc, bag)
  const note = cells[cells.length - 1].source
  assert.match(note, /!\[схема\]\(blob:[0-9a-f]+\.png\)/, `заметка: ${note}`)
  assert.equal(bag.all().length, 1)
  assert.deepEqual(bag.all()[0].body, body)
  assert.ok(releaseSessionDoc('note-ws-publish') !== undefined)
})

test('разметка `<img>` уносится в публикацию тем же способом', () => {
  const doc = roomWith(
    'note-ws-publish-img',
    '<img src="assets/fig03.png" alt="схема">',
    { 'assets/fig03.png': png(3) },
  )
  const note = addedNote(doc)
  assert.match(note, /<img src="blob:[0-9a-f]+\.png" alt="схема">/, `заметка: ${note}`)
  assert.ok(releaseSessionDoc('note-ws-publish-img') !== undefined)
})

test('не картинка и не файл остаются как написаны', () => {
  // `![](data/train.csv.gz)` — это не иллюстрация, а датасет: читать его целиком
  // в память посреди сборки публикации незачем. А ссылка на файл, которого нет,
  // должна остаться ссылкой, а не превратиться в запись публикации.
  const doc = roomWith(
    'note-ws-publish-skip',
    '![данные](data/train.csv.gz)\n\n![нет такого](assets/missing.png)',
    { 'assets/fig01.png': png(1) },
  )
  const bag = newBlobBag()
  const cells = pageOfDoc(doc, bag)
  const note = cells[cells.length - 1].source
  assert.match(note, /!\[данные\]\(data\/train\.csv\.gz\)/)
  assert.match(note, /!\[нет такого\]\(assets\/missing\.png\)/)
  assert.equal(bag.all().length, 0)
  assert.ok(releaseSessionDoc('note-ws-publish-skip') !== undefined)
})

test('файл больше потолка не читается вовсе', () => {
  const room = 'note-ws-big'
  createSession(room, 'Лекция', null)
  makeDir(room, 'assets')
  fs.writeFileSync(path.join(sessionDir(room), 'assets/huge.png'), Buffer.alloc(64 * 1024))
  assert.notEqual(readBytes(room, 'assets/huge.png', 128 * 1024), null)
  assert.equal(readBytes(room, 'assets/huge.png', 1024), null)
  // И за папку семинара он не выходит — как и всё остальное, что её читает.
  assert.equal(readBytes(room, '../../etc/passwd', 1024), null)
})
