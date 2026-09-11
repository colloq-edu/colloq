/**
 * Между полными копиями документа на диск идёт хвост.
 *
 * Полная копия тетради каждые несколько секунд — это то, чем комната платила за
 * простоту восстановления: на тетради в два мегабайта при непрерывном наборе в
 * WAL уходило двадцать шесть мегабайт в минуту ради нескольких килобайт
 * настоящих правок. Хвост — разница с последним снимком — пишется файлом рядом
 * с базой, а полная копия ждёт своего срока.
 *
 * Проверяется здесь ровно то, что в этой сделке можно потерять: обещание
 * сохранности. Снимок плюс хвост обязаны складываться в тетрадь целиком — не «в
 * основном», а посимвольно, — а сам хвост обязан исчезать, когда полная копия
 * лёгла, и когда комнату удалили.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { cellSource, createCell, getCells, readNotebook } from '../shared/notebook.js'
import { config } from '../server/src/config.js'
import { createSession, db, loadDocSnapshot } from '../server/src/db.js'
import { flushPersistence } from '../server/src/collab/persistence.js'
import { dropSessionDoc, getSessionDoc, shutdownCollab } from '../server/src/collab/index.js'

after(() => shutdownCollab())

let seq = 0
function room(): string {
  const id = `tail${seq++}`
  createSession(id, `Tail ${id}`)
  return id
}

const tailFile = (id: string) => path.join(config.dataDir, 'doc-tail', `${id}.bin`)
const snapshotAt = (id: string) =>
  (db.prepare('SELECT updated_at FROM doc_snapshots WHERE session_id = ?').get(id) as
    | { updated_at: number }
    | undefined)?.updated_at ?? 0

/** Ждём, пока сработает отложенная запись (config.snapshotIntervalMs). */
const written = () => new Promise((r) => setTimeout(r, config.snapshotIntervalMs + 600))

/** Что поднимет сервер после `kill -9`: строка снимка плюс хвост рядом с ней. */
function afterCrash(id: string): string[] {
  const doc = new Y.Doc()
  const snapshot = loadDocSnapshot(id)
  if (snapshot) Y.applyUpdate(doc, snapshot)
  if (fs.existsSync(tailFile(id))) Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(tailFile(id))))
  const cells = readNotebook(doc).map((c) => c.source)
  doc.destroy()
  return cells
}

function typeInto(id: string, text: string): void {
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  cells.delete(0, cells.length)
  const cell = createCell('code', '')
  cells.push([cell])
  cellSource(cell).insert(0, text)
}

test('пока печатают, на диск идёт хвост, а не полная копия', async () => {
  const id = room()
  typeInto(id, 'первая строка')
  flushPersistence(id)
  const full = snapshotAt(id)
  assert.ok(loadDocSnapshot(id), 'полная копия должна была лечь сразу')
  assert.equal(fs.existsSync(tailFile(id)), false, 'после полной копии хвоста нет')

  const { doc } = getSessionDoc(id)
  const cell = getCells(doc).get(0)
  cellSource(cell).insert(cellSource(cell).length, ' и продолжение')
  await written()

  assert.ok(fs.existsSync(tailFile(id)), 'продолжение должно было лечь хвостом')
  assert.equal(snapshotAt(id), full, 'полную копию переписывать было незачем')

  const stored = new Y.Doc()
  Y.applyUpdate(stored, loadDocSnapshot(id)!)
  assert.equal(
    readNotebook(stored)[0].source,
    'первая строка',
    'в строке снимка — состояние на момент копии',
  )
  // А вместе с хвостом — всё, что комната написала.
  assert.deepEqual(afterCrash(id), ['первая строка и продолжение'])
})

test('хвост меньше документа: он и есть вся экономия', async () => {
  const id = room()
  const { doc } = getSessionDoc(id)
  const cells = getCells(doc)
  cells.delete(0, cells.length)
  const cell = createCell('code', '')
  cells.push([cell])
  // Тетрадь размером с настоящую: сотня килобайт текста.
  cellSource(cell).insert(0, 'x'.repeat(120 * 1024))
  flushPersistence(id)
  const size = loadDocSnapshot(id)!.byteLength

  cellSource(cell).insert(cellSource(cell).length, 'ещё одна строка')
  await written()

  const tail = fs.statSync(tailFile(id)).size
  assert.ok(size > 100 * 1024, `тетрадь должна быть большой, а она ${size} Б`)
  assert.ok(tail < size / 20, `хвост должен быть на порядок меньше: ${tail} Б против ${size} Б`)
})

test('явный сброс кладёт комнату целиком и уносит хвост', async () => {
  const id = room()
  typeInto(id, 'начало')
  flushPersistence(id)
  const { doc } = getSessionDoc(id)
  const cell = getCells(doc).get(0)
  cellSource(cell).insert(cellSource(cell).length, ' и хвост')
  await written()
  assert.ok(fs.existsSync(tailFile(id)), 'хвост не лёг — дальше проверять нечего')

  flushPersistence(id)
  assert.equal(fs.existsSync(tailFile(id)), false, 'после полной копии хвост убран')
  const stored = new Y.Doc()
  Y.applyUpdate(stored, loadDocSnapshot(id)!)
  assert.equal(readNotebook(stored)[0].source, 'начало и хвост')
})

test('у удалённой комнаты хвоста на диске не остаётся', async () => {
  const id = room()
  typeInto(id, 'занятие')
  flushPersistence(id)
  const { doc } = getSessionDoc(id)
  const cell = getCells(doc).get(0)
  cellSource(cell).insert(cellSource(cell).length, ' продолжается')
  await written()
  assert.ok(fs.existsSync(tailFile(id)), 'хвост не лёг — дальше проверять нечего')

  // Первая строка пути удаления семинара: выселить документ, ничего не записав.
  dropSessionDoc(id)
  assert.equal(fs.existsSync(tailFile(id)), false, 'файл удалённой комнаты остался на диске')
})
