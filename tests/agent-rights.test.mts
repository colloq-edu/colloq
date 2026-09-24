/**
 * The "do" mode and room rules: how a turn differs from the hands of the
 * person asking.
 *
 * The header of agent.ts promises that a turn edits "with the rights of
 * whoever asked". For cells this was checked (agent-cells.test.mts), but for
 * files and running it was not, and it did not hold: in a lecture with
 * `files: 'host'` a participant could, through the oracle, write any file in
 * the seminar folder and run a .py in the shared container. A rule that is
 * bypassed with one button is not a rule, and here it is pinned down with a
 * refusal.
 *
 * Next to it is the conversation budget: what a file read returned stays in
 * the conversation and goes to the provider on EVERY following step, up to
 * twelve times. So the read ceiling is computed from `contextChars` rather
 * than being a fixed number.
 *
 * And undo: the snapshot is taken only after a successful write. Otherwise
 * a turn that changed nothing got an "undo" button, and pressing it blamed a
 * nonexistent editor.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSession, setRules } from '../server/src/db.js'
import { readText, sessionDir } from '../server/src/workspace.js'
import { toolsFor, undoTurn, useTool, type Hands } from '../server/src/ai/agent.js'
import { getOracleSettings, updateOracleSettings } from '../server/src/admin/settings.js'
import { createChatEntry, getChat } from '@shared/notebook'
import { getSessionDoc } from '../server/src/collab/index.js'
import { LECTURE_ROOM, OPEN_ROOM } from '@shared/rules'

const ROOM = 'agent-rights'
const BY = { name: 'Оракул', color: '#0FA0D7', participantId: 'p_oracle' }

function hands(entryId: string, role: 'host' | 'participant'): Hands {
  return { sessionId: ROOM, entryId, by: BY, role }
}

function turn(): string {
  const doc = getSessionDoc(ROOM).doc
  const entry = createChatEntry({
    participantId: BY.participantId,
    name: 'Петя',
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
  createSession(ROOM, 'Права хода', null)
  fs.writeFileSync(path.join(sessionDir(ROOM), 'train.py'), 'x = 1\n')
  fs.writeFileSync(path.join(sessionDir(ROOM), 'go.sh'), 'echo hi\n')
})

test('lecture: a turn does not write files or run scripts for a participant', async () => {
  // Exactly the room where the hole lived: the oracle was given turns, but
  // students may not type or run.
  setRules(ROOM, { ...LECTURE_ROOM, agent: 'room' })
  const id = turn()
  const student = hands(id, 'participant')

  const wrote = await useTool(
    student,
    'write_file',
    JSON.stringify({ path: 'solution.py', content: 'print(1)' }),
  )
  assert.equal(wrote.step.kind, 'note', 'a participant wrote a file under files: host')
  assert.match(wrote.said, /файлы правит преподаватель/i)
  assert.equal(readText(ROOM, 'solution.py'), null, 'the file got created anyway')

  const edited = await useTool(
    student,
    'edit_file',
    JSON.stringify({ path: 'train.py', find: 'x = 1', replace: 'x = 2' }),
  )
  assert.equal(edited.step.kind, 'note')
  assert.equal(readText(ROOM, 'train.py')?.text, 'x = 1\n', 'a targeted edit got past the rule')

  const ran = await useTool(student, 'run_file', JSON.stringify({ path: 'go.sh' }))
  assert.equal(ran.step.kind, 'note', 'a participant ran a script under run: host')
  assert.match(ran.said, /запускает преподаватель/i)

  // Reading is still allowed: the `files` rule in this product is about writing.
  const read = await useTool(student, 'read_file', JSON.stringify({ path: 'train.py' }))
  assert.equal(read.said, 'x = 1\n')

  // And tools that would refuse anyway are not shown to the model: a turn
  // step must not be spent finding out a rule known in advance.
  const offered = toolsFor(student).map((tool) => tool.name)
  assert.ok(!offered.includes('write_file'), 'write_file is offered to someone who may not use it')
  assert.ok(!offered.includes('edit_file'))
  assert.ok(!offered.includes('run_file'))
  assert.ok(offered.includes('read_file'), 'reading was taken away together with writing')
})

test('the teacher in the same room may', async () => {
  const id = turn()
  const teacher = hands(id, 'host')
  const wrote = await useTool(
    teacher,
    'write_file',
    JSON.stringify({ path: 'solution.py', content: 'print(1)' }),
  )
  assert.equal(wrote.step.kind, 'new', wrote.said)
  assert.equal(readText(ROOM, 'solution.py')?.text, 'print(1)')
  assert.ok(
    toolsFor(teacher)
      .map((t) => t.name)
      .includes('run_file'),
  )
})

test('open room: a participant writes files with their own hands, and with the oracle', async () => {
  setRules(ROOM, { ...OPEN_ROOM, agent: 'room' })
  const id = turn()
  const student = hands(id, 'participant')
  const wrote = await useTool(
    student,
    'write_file',
    JSON.stringify({ path: 'mine.py', content: 'print(2)' }),
  )
  assert.equal(wrote.step.kind, 'new', wrote.said)
  assert.equal(readText(ROOM, 'mine.py')?.text, 'print(2)')
  assert.ok(
    toolsFor(student)
      .map((t) => t.name)
      .includes('write_file'),
  )
})

test('the read ceiling is computed from contextChars, and a cut has a continuation', async () => {
  const was = getOracleSettings().contextChars
  try {
    // Eight hundred lines of a hundred characters: a file that fits into no
    // window whole but is read in pages, exactly how a log and a long module
    // are read.
    const lines = Array.from({ length: 800 }, (_, i) => `${String(i).padStart(3, '0')} ${'a'.repeat(95)}`)
    fs.writeFileSync(path.join(sessionDir(ROOM), 'big.py'), lines.join('\n'))
    /*
     * A small model on the teacher's laptop. The ceiling is half the budget,
     * not the whole window: what was read stays in the conversation and
     * repeats on every following step of the turn.
     */
    updateOracleSettings({ contextChars: 40_000 })
    const first = await useTool(hands(turn(), 'host'), 'read_file', JSON.stringify({ path: 'big.py' }))
    assert.ok(first.said.length < 22_000, `read ${first.said.length} characters with a budget of 40 000`)
    assert.ok(first.said.startsWith('000 '), 'reading did not start at the beginning of the file')
    // A cut is no longer a dead end: it says what was shown and how to get the rest.
    assert.match(first.said, /показаны строки 1–\d+ из 800/)
    assert.match(first.said, /read_file по big\.py с offset: \d+/)

    // A page from the middle, by the same offset named in the answer.
    const next = await useTool(hands(turn(), 'host'), 'read_file', JSON.stringify({ path: 'big.py', offset: 200, limit: 10 }))
    assert.ok(next.said.startsWith('200 '), next.said.slice(0, 40))
    assert.equal(next.said.split('\n').filter(line => /^\d{3} a/.test(line)).length, 10)
    assert.match(next.said, /показаны строки 201–210 из 800/)

    // A negative offset is the tail: that is how the end of a log or a traceback is read.
    const tail = await useTool(hands(turn(), 'host'), 'read_file', JSON.stringify({ path: 'big.py', offset: -3 }))
    assert.ok(tail.said.startsWith('797 '), tail.said.slice(0, 40))
    assert.match(tail.said, /показаны строки 798–800 из 800/)

    /*
     * A one-line file gets the same ceiling.
     *
     * A page always keeps at least one line, otherwise it can come out empty,
     * and a single line can be two hundred kilobytes: minified JSON, a
     * dataset in one line. Without a character ceiling such a file would get
     * past any budget.
     */
    fs.writeFileSync(path.join(sessionDir(ROOM), 'one.json'), 'x'.repeat(200_000))
    const flat = await useTool(hands(turn(), 'host'), 'read_file', JSON.stringify({ path: 'one.json' }))
    assert.ok(flat.said.length < 22_000, `one line got through with ${flat.said.length} characters`)
    assert.match(flat.said, /обрезано/)

    // The ceiling really grows with the budget instead of being a fixed number.
    updateOracleSettings({ contextChars: 8_000 })
    const narrow = await useTool(hands(turn(), 'host'), 'read_file', JSON.stringify({ path: 'big.py' }))
    assert.ok(narrow.said.length < first.said.length, 'the narrow window read no less than the wide one')
    assert.ok(narrow.said.length > 8_000, 'the lower bound of a read is below twelve thousand characters')
  } finally {
    updateOracleSettings({ contextChars: was })
  }
})

test('the write failed: there is nothing to undo, and there must be no "undo" button', async () => {
  const id = turn()
  // A file cannot be created inside a file: mkdir on the path `train.py/…` gives ENOTDIR.
  const tried = await useTool(
    hands(id, 'host'),
    'write_file',
    JSON.stringify({ path: 'train.py/child.py', content: 'нет' }),
  )
  assert.equal(tried.step.kind, 'note', tried.said)
  assert.match(tried.said, /Не получилось (?:записать|создать)|не удалось/i)
  /*
   * `null`, not `0`: there is no snapshot at all. While `remember` stood
   * BEFORE the write, a snapshot remained even from a failure: the turn got
   * `undo: 'available'`, and pressing it appended "left alone:
   * train.py/child.py (the file was changed or removed after this turn)"
   * under it. Nobody touched the file, and the turn changed nothing.
   */
  assert.equal(undoTurn(ROOM, id, 'Ада'), null, 'a failed write left an undo snapshot behind')
})
