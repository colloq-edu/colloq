/**
 * Границы режима «сделать».
 *
 * Модель здесь не участвует: проверяются руки, а не голова. Всё, что ниже,
 * ломается тихо — оракул сообщает об успехе, а в файле не то, что он думает,
 * или отмена возвращает не туда, где были.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSession } from '../server/src/db.js'
import { MAX_TEXT_BYTES, readText, sessionDir } from '../server/src/workspace.js'
import { getFileDoc, flushAllFiles, TEXT_KEY } from '../server/src/collab/files.js'
import { useTool, undoTurn, type Hands } from '../server/src/ai/agent.js'
import { chatAnswer, findChatEntry, getChat, createChatEntry } from '@shared/notebook'
import { getSessionDoc } from '../server/src/collab/index.js'

const ROOM = 'agent-room'
const BY = { name: 'Оракул', color: '#0FA0D7', participantId: 'p_oracle' }

function hands(entryId: string, role: 'host' | 'participant' = 'host'): Hands {
  return { sessionId: ROOM, entryId, by: BY, role }
}

/** Путь к файлу в папке семинара — тесты ниже ходят туда мимо оракула. */
function at(name: string): string {
  return path.join(sessionDir(ROOM), name)
}

/** Завести запись треда, к которой привязывается отмена. */
function turn(): string {
  const doc = getSessionDoc(ROOM).doc
  const entry = createChatEntry({
    participantId: 'p_ada',
    name: 'Ада',
    color: '#F97362',
    question: 'сделай',
    mode: 'agent',
  })
  doc.transact(() => getChat(doc).push([entry]))
  const id = entry.get('id') as string
  doc.transact(() => entry.set('undo', 'available'))
  return id
}

test('комната заводится', () => {
  createSession(ROOM, 'Agent', null)
  fs.writeFileSync(path.join(sessionDir(ROOM), 'train.py'), 'x = 1\ny = 2\n')
})

test('читает то, что есть, и честно отказывает в том, чего нет', async () => {
  const id = turn()
  const read = await useTool(hands(id), 'read_file', JSON.stringify({ path: 'train.py' }))
  assert.equal(read.said, 'x = 1\ny = 2\n')
  assert.equal(read.step.kind, 'read')

  const missing = await useTool(hands(id), 'read_file', JSON.stringify({ path: 'nope.py' }))
  assert.match(missing.said, /нет или он не текст/)
  assert.equal(missing.step.kind, 'note')
})

test('наружу папки семинара не выходит', async () => {
  const id = turn()
  for (const wanted of ['../secret', '/etc/passwd', 'src/../../out']) {
    const tried = await useTool(hands(id), 'read_file', JSON.stringify({ path: wanted }))
    assert.equal(tried.step.kind, 'note', wanted)
    assert.match(tried.said, /невозможен/, wanted)
  }
})

test('точечная правка требует однозначного куска', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'twice.py'), 'a = 1\nb = 1\n')

  const ambiguous = await useTool(
    hands(id),
    'edit_file',
    JSON.stringify({ path: 'twice.py', find: '= 1', replace: '= 2' }),
  )
  assert.match(ambiguous.said, /больше одного раза/)
  assert.equal(
    readText(ROOM, 'twice.py')?.text,
    'a = 1\nb = 1\n',
    'неоднозначная правка всё-таки записалась',
  )

  const exact = await useTool(
    hands(id),
    'edit_file',
    JSON.stringify({ path: 'twice.py', find: 'b = 1', replace: 'b = 2' }),
  )
  assert.equal(exact.step.kind, 'write')
  flushAllFiles()
  assert.equal(readText(ROOM, 'twice.py')?.text, 'a = 1\nb = 2\n')
})

test('правка, которой некуда лечь, не выдаёт себя за удачу', async () => {
  const id = turn()
  const nowhere = await useTool(
    hands(id),
    'edit_file',
    JSON.stringify({ path: 'train.py', find: 'этого там нет', replace: 'x' }),
  )
  assert.equal(nowhere.step.kind, 'note')
  assert.match(nowhere.said, /нет такого текста/)
})

test('счёт строк в ленте — про то, что правда изменилось', async () => {
  const id = turn()
  const wrote = await useTool(
    hands(id),
    'write_file',
    JSON.stringify({ path: 'train.py', content: 'x = 1\ny = 2\nz = 3\n' }),
  )
  assert.equal(wrote.step.added, 1, 'прибавилась одна строка, а не весь файл')
  assert.equal(wrote.step.removed, 0)
})

test('отмена возвращает файл к тому, что было до хода', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'undo.py'), 'исходное\n')

  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'undo.py', content: 'первое\n' }))
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'undo.py', content: 'второе\n' }))
  flushAllFiles()
  assert.equal(readText(ROOM, 'undo.py')?.text, 'второе\n')

  // К исходному, а не к предыдущей правке того же хода: отменяют решение
  // целиком, а не последний шаг.
  assert.equal(undoTurn(ROOM, id, 'Ада'), 1)
  flushAllFiles()
  assert.equal(readText(ROOM, 'undo.py')?.text, 'исходное\n')

  const entry = findChatEntry(getSessionDoc(ROOM).doc, id)
  assert.equal(entry?.get('undo'), 'done')
  assert.equal(entry?.get('undoBy'), 'Ада')
})

test('отменить дважды нельзя', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'once.py'), 'было\n')
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'once.py', content: 'стало\n' }))
  assert.equal(undoTurn(ROOM, id, 'Ада'), 1)
  assert.equal(undoTurn(ROOM, id, 'Ада'), null, 'вторая отмена вернула бы файл к «стало»')
})

test('правка открытого файла идёт в документ, а не мимо редактора', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'open.py'), 'a = 1\n')
  const doc = getFileDoc(ROOM, 'open.py')
  assert.ok(doc)
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'open.py', content: 'a = 2\n' }))
  assert.equal(
    doc.doc.getText(TEXT_KEY).toString(),
    'a = 2\n',
    'редактор показывал бы старое, а на диске лежало бы новое',
  )
})

test('запускается только то, чем есть что запустить', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'data.csv'), 'a,b\n')
  const tried = await useTool(hands(id), 'run_file', JSON.stringify({ path: 'data.csv' }))
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /не скрипт/)
})

test('несуществующего инструмента нет', async () => {
  const id = turn()
  const tried = await useTool(hands(id), 'delete_file', JSON.stringify({ path: 'train.py' }))
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /нет/)
  assert.ok(readText(ROOM, 'train.py'), 'файл всё-таки исчез')
})

/* --------------------------------------------- чего оракулу не отдают */

test('файл больше потолка не переписывается своим же обрезком', async () => {
  const id = turn()
  // Больше MAX_TEXT_BYTES: столько оракул увидеть не может — `currentText`
  // отдаёт ему только начало, и запись начала поверх целого унесла бы хвост.
  fs.writeFileSync(at('big.csv'), 'колонка,значение\n'.repeat(60_000))
  const bytes = fs.statSync(at('big.csv')).size
  assert.ok(bytes > MAX_TEXT_BYTES, 'файл для теста оказался меньше потолка')

  const wrote = await useTool(
    hands(id),
    'write_file',
    JSON.stringify({ path: 'big.csv', content: 'колонка,значение\n' }),
  )
  assert.equal(wrote.step.kind, 'note')
  assert.match(wrote.said, /больше полутора мегабайт/)

  const edited = await useTool(
    hands(id),
    'edit_file',
    JSON.stringify({ path: 'big.csv', find: 'колонка,значение\n', replace: 'a,b\n' }),
  )
  assert.equal(edited.step.kind, 'note')
  assert.equal(fs.statSync(at('big.csv')).size, bytes, 'хвост файла исчез молча')
})

test('двоичный файл оракул не перетирает текстом', async () => {
  const id = turn()
  const bytes = Buffer.from([0x89, 0x50, 0x00, 0x1a, 0x00, 0xff])
  fs.writeFileSync(at('model.bin'), bytes)
  const wrote = await useTool(
    hands(id),
    'write_file',
    JSON.stringify({ path: 'model.bin', content: 'привет' }),
  )
  assert.equal(wrote.step.kind, 'note')
  assert.match(wrote.said, /не текстовый файл/)
  assert.deepEqual(fs.readFileSync(at('model.bin')), bytes)

  const read = await useTool(hands(id), 'read_file', JSON.stringify({ path: 'model.bin' }))
  assert.match(read.said, /не текстовый файл/)
})

test('про большой файл сказано, что он большой, а не что его нет', async () => {
  const id = turn()
  fs.writeFileSync(at('huge.csv'), 'колонка,значение\n'.repeat(60_000))
  assert.ok(fs.statSync(at('huge.csv')).size > MAX_TEXT_BYTES, 'файл оказался меньше потолка')

  const read = await useTool(hands(id), 'read_file', JSON.stringify({ path: 'huge.csv' }))
  // «Файла нет или он не текст» — приглашение завести его заново поверх
  // датасета: ровно та потеря хвоста, ради которой потолок и поставлен.
  assert.doesNotMatch(read.said, /нет или он не текст/)
  assert.match(read.said, /больше полутора мегабайт/)
  assert.match(read.said, /колонка,значение/, 'начала файла модель не увидела')
  assert.equal(read.step.note, 'только начало')

  const edited = await useTool(
    hands(id),
    'edit_file',
    JSON.stringify({ path: 'huge.csv', find: 'колонка', replace: 'column' }),
  )
  assert.match(edited.said, /больше полутора мегабайт/)
})

test('файл сверх потолка оракул не заводит и сам', async () => {
  const id = turn()
  const wrote = await useTool(
    hands(id),
    'write_file',
    JSON.stringify({ path: 'made-big.txt', content: 'x'.repeat(MAX_TEXT_BYTES + 1) }),
  )
  assert.equal(wrote.step.kind, 'note')
  assert.match(wrote.said, /полутора мегабайт/)
  // Иначе на диске осталась бы пустышка: файл заводится до записи, а запись
  // сверх потолка не сохранится ни сейчас, ни потом.
  assert.equal(fs.existsSync(at('made-big.txt')), false)
})

/* ------------------------------------------ отмена смотрит, что вернёт */

test('отмена не трогает файл, который правили после хода', async () => {
  const id = turn()
  fs.writeFileSync(at('after.py'), 'было\n')
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'after.py', content: 'оракул\n' }))
  flushAllFiles()
  // Сорок минут работы студента поверх правки оракула.
  fs.writeFileSync(at('after.py'), 'оракул\nи много ручной работы\n')

  assert.equal(undoTurn(ROOM, id, 'Ада'), 0)
  assert.equal(readText(ROOM, 'after.py')?.text, 'оракул\nи много ручной работы\n')
  const entry = findChatEntry(getSessionDoc(ROOM).doc, id)
  assert.match(
    chatAnswer(entry!).toString(),
    /after\.py/,
    'в треде не сказано, что файл не вернули',
  )
})

test('отмена не воскрешает файл, который убрали после хода', async () => {
  const id = turn()
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'ghost.py', content: 'x = 1\n' }))
  flushAllFiles()
  fs.rmSync(at('ghost.py'))

  assert.equal(undoTurn(ROOM, id, 'Ада'), 0)
  assert.equal(fs.existsSync(at('ghost.py')), false, 'на месте убранного файла появился призрак')
})

test('после переименования отмена не пишет поверх нового файла со старым именем', async () => {
  const id = turn()
  fs.writeFileSync(at('renamed.py'), 'исходное\n')
  await useTool(
    hands(id),
    'write_file',
    JSON.stringify({ path: 'renamed.py', content: 'от оракула\n' }),
  )
  flushAllFiles()
  fs.renameSync(at('renamed.py'), at('moved.py'))
  fs.writeFileSync(at('renamed.py'), 'новый файл человека\n')

  assert.equal(undoTurn(ROOM, id, 'Ада'), 0)
  assert.equal(readText(ROOM, 'renamed.py')?.text, 'новый файл человека\n')
  assert.equal(readText(ROOM, 'moved.py')?.text, 'от оракула\n')
})

test('отмена старого хода не возвращает правку нового', async () => {
  /*
   * Два поручения подряд про один файл. Отмена старого вернула бы файл к тому,
   * что было до него, — то есть стёрла бы весь второй ход, а потом отмена
   * второго вернула бы правку первого, которую только что отменили.
   */
  const first = turn()
  const second = turn()
  fs.writeFileSync(at('two.py'), 'v0\n')
  await useTool(hands(first), 'write_file', JSON.stringify({ path: 'two.py', content: 'v1\n' }))
  await useTool(hands(second), 'write_file', JSON.stringify({ path: 'two.py', content: 'v2\n' }))
  flushAllFiles()

  assert.equal(undoTurn(ROOM, first, 'Ада'), 0, 'старый ход перетёр работу нового')
  assert.equal(readText(ROOM, 'two.py')?.text, 'v2\n')
  assert.equal(undoTurn(ROOM, second, 'Ада'), 1)
  assert.equal(readText(ROOM, 'two.py')?.text, 'v1\n')
})

test('дерево файлов уезжает модели с потолком', async () => {
  const id = turn()
  // Распакованный датасет: одна папка, тысяча имён, и весь список повторялся
  // бы в каждом следующем запросе хода.
  fs.mkdirSync(at('images'), { recursive: true })
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(at('images'), `img_${i}.png`), 'x')

  const listed = await useTool(hands(id), 'list_files', '{}')
  const lines = listed.said.split('\n')
  assert.ok(lines.length < 120, `в кадр уехало ${lines.length} строк`)
  assert.match(listed.said, /images\/img_0\.png/, 'начала папки не видно')
  assert.match(listed.said, /ещё \d+ в images\//, 'не сказано, сколько осталось за кадром')
})
