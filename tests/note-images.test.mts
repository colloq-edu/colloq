/**
 * Картинки заметок живут на полке комнаты, а не в её документе.
 *
 * Ломается это тихо и дорого: тетрадь лекции, где условия задач нарисованы
 * картинками, переезжает в комнату base64-строками — замер на живой комнате
 * `pvhu2h7f` дал документ на 10.5 МБ, из которых 9.4 МБ были ровно этим. Такой
 * документ едет ЦЕЛИКОМ каждому вошедшему, сервер закрывает не успевающие
 * сокеты, и студент на медленном канале не догоняет комнату никогда.
 *
 * Поэтому проверяется весь круг: файл → комната → файл. Потерять картинку на
 * обратном пути так же плохо, как везти её в документе: тетрадь, унесённую к
 * себе, открывают без нашего сервера.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { makeFile } from '../server/src/workspace.js'
import { getSessionDoc, releaseSessionDoc } from '../server/src/collab/index.js'
import { openBook, projectBooks } from '../server/src/collab/books.js'
import { readBlob } from '../server/src/blobs.js'
import {
  inlineCellImages,
  shelveCellImages,
  shelveRoomImages,
} from '../server/src/notebook-images.js'
import { newBlobBag, pageOfDoc } from '../server/src/publish/build.js'
import { parseIpynb, readIpynb, writeIpynb } from '../shared/ipynb.js'
import { attachmentName, findInlineImages } from '../shared/images.js'
import { bookCells, cellSource, createCell, getCells } from '../shared/notebook.js'

/** Настоящий PNG на ~120 КБ: восемь байт заголовка и много нулей после них. */
function bigPng(seed = 1): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const body = Buffer.alloc(120 * 1024, seed)
  return Buffer.concat([head, body])
}

const PNG = bigPng()
const PNG_B64 = PNG.toString('base64')

test('внесение тетради: картинка из текста уезжает на полку, в ячейке остаётся ссылка', () => {
  const room = 'note-img-import'
  createSession(room, 'Картинки', null)
  const file = JSON.stringify({
    cells: [
      {
        cell_type: 'markdown',
        source: [`## Задача\n`, `![схема](data:image/png;base64,${PNG_B64})\n`],
      },
      { cell_type: 'code', source: `img = "data:image/png;base64,${PNG_B64.slice(0, 40_000)}"\n` },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })
  assert.equal(makeFile(room, 'Лекция.ipynb', file), 'ok')
  const opened = openBook(room, 'Лекция.ipynb')
  assert.ok(opened.ok, 'тетрадь не внеслась')

  const { doc } = getSessionDoc(room)
  const cells = bookCells(doc, opened.ok ? opened.book.root : 'cells')
  const note = cellSource(cells.get(0)).toString()
  assert.ok(!note.includes('base64'), 'картинка осталась в тексте ячейки')
  assert.match(note, /!\[схема\]\(attachment:[0-9a-f]{64}\.png\)/)

  // Байты — на полке, и найти их можно по имени из ссылки.
  const sha = /attachment:([0-9a-f]{64})\.png/.exec(note)?.[1] ?? ''
  assert.deepEqual(readBlob(room, sha), PNG)

  /*
   * Код не трогаем НИКОГДА: `data:image/png;base64,…` в нём — это строка,
   * которую написал человек, и подменить её ссылкой значит молча переписать
   * чужую программу.
   */
  assert.ok(cellSource(cells.get(1)).toString().includes('base64'), 'переписан код, а не заметка')

  /*
   * Документ полегчал на всю картинку заметки. Мерить целиком нельзя: в этой
   * же тетради нарочно лежит код с base64 в строке, и он остаётся как был —
   * иначе проверка поощряла бы правку чужой программы.
   */
  const weight = note.length
  assert.ok(weight < 2_000, `заметка всё ещё тяжёлая: ${weight} знаков`)
})

test('вложения nbformat доезжают до комнаты и тоже ложатся на полку', () => {
  const room = 'note-img-attach'
  createSession(room, 'Вложения', null)
  const png = bigPng(2)
  const file = JSON.stringify({
    cells: [
      {
        cell_type: 'markdown',
        source: '![схема](attachment:схема.png)\n',
        attachments: { 'схема.png': { 'image/png': png.toString('base64') } },
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  })
  // Разбор обязан донести вложения: до этого он читал мимо них, и ссылка
  // приезжала в комнату без своих байтов.
  const flat = parseIpynb(file)
  assert.ok(flat && flat[0].attachments?.['схема.png']?.['image/png'])

  assert.equal(makeFile(room, 'Схемы.ipynb', file), 'ok')
  const opened = openBook(room, 'Схемы.ipynb')
  assert.ok(opened.ok)
  const { doc } = getSessionDoc(room)
  const note = cellSource(bookCells(doc, opened.ok ? opened.book.root : 'cells').get(0)).toString()
  const sha = /attachment:([0-9a-f]{64})\.png/.exec(note)?.[1] ?? ''
  assert.ok(sha, `ссылка не переписана: ${note.slice(0, 80)}`)
  assert.deepEqual(readBlob(room, sha), png)
})

test('проекция на диск возвращает картинку вложением — файл открывается без сервера', () => {
  const room = 'note-img-import'
  projectBooks(room)
  const { doc } = getSessionDoc(room)
  // Файл читается тем же разбором, каким его прочтёт чужой Jupyter.
  const flat = parseIpynb(
    fs.readFileSync(path.join(process.env.WORKSPACE_DIR ?? '', room, 'Лекция.ipynb'), 'utf8'),
  )
  assert.ok(flat, 'файл перестал быть тетрадью')
  const name = Object.keys(flat[0].attachments ?? {})[0] ?? ''
  assert.match(name, /^[0-9a-f]{64}\.png$/)
  assert.equal(flat[0].attachments?.[name]?.['image/png'], PNG_B64)
  // И ссылка в тексте зовёт ровно это вложение.
  assert.ok(flat[0].source.includes(`attachment:${name}`))
  assert.ok(doc)
})

test('круг файл → комната → файл сохраняет байты картинки', () => {
  const room = 'note-img-roundtrip'
  createSession(room, 'Круг', null)
  const png = bigPng(3)
  const first = writeIpynb([
    {
      type: 'markdown',
      source: `![a](data:image/png;base64,${png.toString('base64')})`,
      id: 'c1',
    },
  ])
  const shelved = readIpynb(JSON.parse(first)).map((cell) => shelveCellImages(room, cell))
  assert.ok(!shelved[0].source.includes('base64'))
  const back = writeIpynb(shelved.map((cell) => inlineCellImages(room, cell)))
  const reread = parseIpynb(back)
  const name = attachmentName(createHash('sha256').update(png).digest('hex'), 'image/png')
  assert.equal(reread?.[0].attachments?.[name]?.['image/png'], png.toString('base64'))
})

test('комната, открытая после этой правки, разгружается сама и только один раз', () => {
  const room = 'note-img-migrate'
  createSession(room, 'Старая комната', null)
  const { doc } = getSessionDoc(room)
  const png = bigPng(4)
  doc.transact(() => {
    getCells(doc).push([
      createCell('markdown', `![старое](data:image/png;base64,${png.toString('base64')})`),
      createCell('code', `s = "data:image/png;base64,${png.toString('base64')}"`),
    ])
  })
  const heavy = Y.encodeStateAsUpdate(doc).byteLength

  assert.equal(shelveRoomImages(room, doc), 1, 'разгружена не одна ячейка')
  // Своя ячейка среди стартовых: комната засевает тетрадь приветствием.
  const note = getCells(doc)
    .map((cell) => cellSource(cell).toString())
    .find((text) => text.startsWith('![старое]')) ?? ''
  assert.match(note, /attachment:[0-9a-f]{64}\.png/)
  assert.equal(findInlineImages(note).length, 0)
  assert.ok(Y.encodeStateAsUpdate(doc).byteLength < heavy, 'документ не полегчал')

  // Второй проход не пишет в документ вовсе: иначе каждое открытие комнаты
  // стоило бы версии в истории и снимка в базе.
  const after = Y.encodeStateAsUpdate(doc).byteLength
  assert.equal(shelveRoomImages(room, doc), 0)
  assert.equal(Y.encodeStateAsUpdate(doc).byteLength, after)
  assert.ok(releaseSessionDoc(room) !== undefined)
})

test('публикация уносит картинку заметки в свои записи, а не строкой base64', () => {
  const room = 'note-img-publish'
  createSession(room, 'Публикация', null)
  const { doc } = getSessionDoc(room)
  const png = bigPng(5)
  const shelvedSource = shelveCellImages(room, {
    type: 'markdown',
    source: `![схема](data:image/png;base64,${png.toString('base64')})`,
  }).source
  doc.transact(() => {
    getCells(doc).push([createCell('markdown', shelvedSource)])
  })
  const bag = newBlobBag()
  const page = pageOfDoc(doc, bag)
  const note = page.map((cell) => cell.source).find((text) => text.startsWith('![схема]')) ?? ''
  assert.match(note, /!\[схема\]\(blob:[0-9a-f]+\.png\)/, `заметка: ${note.slice(0, 90)}`)
  assert.equal(bag.all().length, 1)
  assert.deepEqual(bag.all()[0].body, png)
})
