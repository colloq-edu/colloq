/**
 * The limits of the "do" mode.
 *
 * The model takes no part here: the hands are checked, not the head.
 * Everything below breaks quietly: the oracle reports success while the file
 * holds something other than it thinks, or undo goes back to the wrong place.
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

/** A path to a file in the seminar folder: the tests below go there bypassing the oracle. */
function at(name: string): string {
  return path.join(sessionDir(ROOM), name)
}

/** Create the thread record that undo is bound to. */
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

test('the room is set up', () => {
  createSession(ROOM, 'Agent', null)
  fs.writeFileSync(path.join(sessionDir(ROOM), 'train.py'), 'x = 1\ny = 2\n')
})

test('reads what exists and honestly refuses what does not', async () => {
  const id = turn()
  const read = await useTool(hands(id), 'read_file', JSON.stringify({ path: 'train.py' }))
  assert.equal(read.said, 'x = 1\ny = 2\n')
  assert.equal(read.step.kind, 'read')

  const missing = await useTool(hands(id), 'read_file', JSON.stringify({ path: 'nope.py' }))
  assert.match(missing.said, /нет или он не текст/)
  assert.equal(missing.step.kind, 'note')
})

test('does not step outside the seminar folder', async () => {
  const id = turn()
  for (const wanted of ['../secret', '/etc/passwd', 'src/../../out']) {
    const tried = await useTool(hands(id), 'read_file', JSON.stringify({ path: wanted }))
    assert.equal(tried.step.kind, 'note', wanted)
    assert.match(tried.said, /невозможен/, wanted)
  }
})

test('a targeted edit requires an unambiguous piece', async () => {
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
    'the ambiguous edit got written anyway',
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

test('an edit with nowhere to land does not pass itself off as a success', async () => {
  const id = turn()
  const nowhere = await useTool(
    hands(id),
    'edit_file',
    JSON.stringify({ path: 'train.py', find: 'этого там нет', replace: 'x' }),
  )
  assert.equal(nowhere.step.kind, 'note')
  assert.match(nowhere.said, /нет такого текста/)
})

test('the line count in the feed is about what really changed', async () => {
  const id = turn()
  const wrote = await useTool(
    hands(id),
    'write_file',
    JSON.stringify({ path: 'train.py', content: 'x = 1\ny = 2\nz = 3\n' }),
  )
  assert.equal(wrote.step.added, 1, 'one line was added, not the whole file')
  assert.equal(wrote.step.removed, 0)
})

test('undo returns the file to what it was before the turn', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'undo.py'), 'исходное\n')

  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'undo.py', content: 'первое\n' }))
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'undo.py', content: 'второе\n' }))
  flushAllFiles()
  assert.equal(readText(ROOM, 'undo.py')?.text, 'второе\n')

  // To the original, not to the previous edit of the same turn: the decision
  // is undone as a whole, not its last step.
  assert.equal(undoTurn(ROOM, id, 'Ада'), 1)
  flushAllFiles()
  assert.equal(readText(ROOM, 'undo.py')?.text, 'исходное\n')

  const entry = findChatEntry(getSessionDoc(ROOM).doc, id)
  assert.equal(entry?.get('undo'), 'done')
  assert.equal(entry?.get('undoBy'), 'Ада')
})

test('undo cannot be done twice', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'once.py'), 'было\n')
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'once.py', content: 'стало\n' }))
  assert.equal(undoTurn(ROOM, id, 'Ада'), 1)
  assert.equal(undoTurn(ROOM, id, 'Ада'), null, 'a second undo would have returned the file to its edited state')
})

test('an edit of an open file goes into the document, not around the editor', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'open.py'), 'a = 1\n')
  const doc = getFileDoc(ROOM, 'open.py')
  assert.ok(doc)
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'open.py', content: 'a = 2\n' }))
  assert.equal(
    doc.doc.getText(TEXT_KEY).toString(),
    'a = 2\n',
    'the editor would show the old text while the new one sat on disk',
  )
})

test('only what can be run gets run', async () => {
  const id = turn()
  fs.writeFileSync(path.join(sessionDir(ROOM), 'data.csv'), 'a,b\n')
  const tried = await useTool(hands(id), 'run_file', JSON.stringify({ path: 'data.csv' }))
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /не скрипт/)
})

test('a nonexistent tool does not exist', async () => {
  const id = turn()
  const tried = await useTool(hands(id), 'delete_file', JSON.stringify({ path: 'train.py' }))
  assert.equal(tried.step.kind, 'note')
  assert.match(tried.said, /нет/)
  assert.ok(readText(ROOM, 'train.py'), 'the file disappeared anyway')
})

/* --------------------------------------- what the oracle is not given */

test('a file over the ceiling is not overwritten by its own truncated copy', async () => {
  const id = turn()
  // Larger than MAX_TEXT_BYTES: the oracle cannot see that much, `currentText`
  // gives it only the beginning, and writing the beginning over the whole
  // file would take the tail away.
  fs.writeFileSync(at('big.csv'), 'колонка,значение\n'.repeat(60_000))
  const bytes = fs.statSync(at('big.csv')).size
  assert.ok(bytes > MAX_TEXT_BYTES, 'the test file turned out smaller than the ceiling')

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
  assert.equal(fs.statSync(at('big.csv')).size, bytes, 'the tail of the file disappeared silently')
})

test('the oracle does not overwrite a binary file with text', async () => {
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

test('a big file is said to be big, not missing', async () => {
  const id = turn()
  fs.writeFileSync(at('huge.csv'), 'колонка,значение\n'.repeat(60_000))
  assert.ok(fs.statSync(at('huge.csv')).size > MAX_TEXT_BYTES, 'the file turned out smaller than the ceiling')

  const read = await useTool(hands(id), 'read_file', JSON.stringify({ path: 'huge.csv' }))
  // "The file does not exist or is not text" is an invitation to create it
  // again on top of the dataset: exactly the loss of the tail the ceiling was
  // set up against.
  assert.doesNotMatch(read.said, /нет или он не текст/)
  assert.match(read.said, /больше полутора мегабайт/)
  assert.match(read.said, /колонка,значение/, 'the model did not see the beginning of the file')
  assert.equal(read.step.note, 'только начало')

  const edited = await useTool(
    hands(id),
    'edit_file',
    JSON.stringify({ path: 'huge.csv', find: 'колонка', replace: 'column' }),
  )
  assert.match(edited.said, /больше полутора мегабайт/)
})

test('the oracle does not create a file over the ceiling itself either', async () => {
  const id = turn()
  const wrote = await useTool(
    hands(id),
    'write_file',
    JSON.stringify({ path: 'made-big.txt', content: 'x'.repeat(MAX_TEXT_BYTES + 1) }),
  )
  assert.equal(wrote.step.kind, 'note')
  assert.match(wrote.said, /полутора мегабайт/)
  // Otherwise an empty stub would stay on disk: the file is created before
  // the write, and a write over the ceiling is saved neither now nor later.
  assert.equal(fs.existsSync(at('made-big.txt')), false)
})

/* --------------------------------------- undo looks at what it returns */

test('undo does not touch a file edited after the turn', async () => {
  const id = turn()
  fs.writeFileSync(at('after.py'), 'было\n')
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'after.py', content: 'оракул\n' }))
  flushAllFiles()
  // Forty minutes of a student's work on top of the oracle's edit.
  fs.writeFileSync(at('after.py'), 'оракул\nи много ручной работы\n')

  assert.equal(undoTurn(ROOM, id, 'Ада'), 0)
  assert.equal(readText(ROOM, 'after.py')?.text, 'оракул\nи много ручной работы\n')
  const entry = findChatEntry(getSessionDoc(ROOM).doc, id)
  assert.match(
    chatAnswer(entry!).toString(),
    /after\.py/,
    'the thread does not say that the file was not restored',
  )
})

test('undo does not resurrect a file removed after the turn', async () => {
  const id = turn()
  await useTool(hands(id), 'write_file', JSON.stringify({ path: 'ghost.py', content: 'x = 1\n' }))
  flushAllFiles()
  fs.rmSync(at('ghost.py'))

  assert.equal(undoTurn(ROOM, id, 'Ада'), 0)
  assert.equal(fs.existsSync(at('ghost.py')), false, 'a ghost appeared in place of the removed file')
})

test('after a rename, undo does not write over a new file with the old name', async () => {
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

test('undoing an old turn does not revert the edit of a new one', async () => {
  /*
   * Two requests in a row about one file. Undoing the older one would return
   * the file to what it was before it, that is, erase the whole second turn,
   * and then undoing the second would bring back the edit of the first,
   * which had just been undone.
   */
  const first = turn()
  const second = turn()
  fs.writeFileSync(at('two.py'), 'v0\n')
  await useTool(hands(first), 'write_file', JSON.stringify({ path: 'two.py', content: 'v1\n' }))
  await useTool(hands(second), 'write_file', JSON.stringify({ path: 'two.py', content: 'v2\n' }))
  flushAllFiles()

  assert.equal(undoTurn(ROOM, first, 'Ада'), 0, 'the old turn overwrote the work of the new one')
  assert.equal(readText(ROOM, 'two.py')?.text, 'v2\n')
  assert.equal(undoTurn(ROOM, second, 'Ада'), 1)
  assert.equal(readText(ROOM, 'two.py')?.text, 'v1\n')
})

test('the file tree goes to the model with a ceiling', async () => {
  const id = turn()
  // An unpacked dataset: one folder, a thousand names, and the whole list
  // would repeat in every following request of the turn.
  fs.mkdirSync(at('images'), { recursive: true })
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(at('images'), `img_${i}.png`), 'x')

  const listed = await useTool(hands(id), 'list_files', '{}')
  const lines = listed.said.split('\n')
  assert.ok(lines.length < 120, `${lines.length} lines went into the frame`)
  assert.match(listed.said, /images\/img_0\.png/, 'the beginning of the folder is not visible')
  assert.match(listed.said, /ещё \d+ в images\//, 'it does not say how many are left out of the frame')
})
