/**
 * Taking an answer apart.
 *
 * The panel draws prose and code differently — one goes through the markdown
 * renderer, the other gets a strip with Copy and New cell — so the split has to
 * be right about where one ends and the other begins. It also has to be right
 * about a block that has not finished arriving, because that is the state a
 * block is in for most of the seconds it is on screen, and a half-written
 * snippet must not be offered as something to run.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as Y from 'yjs'
import { lastCodeBlock, splitAnswer } from '../shared/answer.js'
import { createChatEntry, getChat, readChatEntry } from '../shared/notebook.js'

test('an answer with no code is one piece of prose', () => {
  const parts = splitAnswer('The batch is not what fills the card.')
  assert.deepEqual(parts, [{ kind: 'prose', text: 'The batch is not what fills the card.' }])
})

test('prose and a block come back in the order they were written', () => {
  const parts = splitAnswer('Try this:\n\n```python\nx = 1\n```\n\nThen run it.')
  assert.deepEqual(parts, [
    { kind: 'prose', text: 'Try this:\n' },
    { kind: 'code', lang: 'python', code: 'x = 1', closed: true },
    { kind: 'prose', text: '\nThen run it.' },
  ])
})

test('a block still being written is marked unclosed', () => {
  // The model is mid-sentence. Nothing here may be copied or run.
  const parts = splitAnswer('almost:\n\n```python\nmodel = Net(')
  assert.equal(parts.length, 2)
  assert.deepEqual(parts[1], { kind: 'code', lang: 'python', code: 'model = Net(', closed: false })
})

test('the fence language is kept, lowercased', () => {
  const [block] = splitAnswer('```Python\nx = 1\n```')
  assert.equal(block.kind === 'code' && block.lang, 'python')
})

test('a fence carrying a language does not close an open block', () => {
  /*
   * A line reading ```python inside python is not a thing, and treating it as a
   * close would cut one block into two halves that each look complete — the
   * second of which would then be taken as the proposal.
   */
  const parts = splitAnswer('```python\na = 1\n```js\nb = 2\n```')
  assert.equal(parts.length, 1)
  assert.equal(parts[0].kind === 'code' && parts[0].code, 'a = 1\n```js\nb = 2')
})

test('the blank line markdown needs before a fence is not drawn as prose', () => {
  const parts = splitAnswer('\n\n```\nx = 1\n```\n\n')
  assert.deepEqual(parts, [{ kind: 'code', lang: '', code: 'x = 1', closed: true }])
})

test('a block a model opened and closed with nothing in it is dropped', () => {
  assert.deepEqual(splitAnswer('here:\n\n```python\n\n```'), [
    { kind: 'prose', text: 'here:\n' },
  ])
})

test('a block in another language is code, but not a proposal', () => {
  // It still renders, with its own strip; it is simply not a cell's source.
  const answer = 'In the shell:\n\n```bash\npip install torch\n```'
  assert.equal(splitAnswer(answer).length, 2)
  assert.equal(lastCodeBlock(answer), null)
})

test('reading a turn never writes to the document', () => {
  /*
   * readChatEntry runs in every browser on every observer pass. It used to
   * reach the reasoning text through the getter that creates one when missing,
   * which turned reading a nine-week-old thread into a write per turn — inside
   * the callback that fires on writes.
   */
  const doc = new Y.Doc()
  const entry = createChatEntry({
    participantId: 'p1',
    name: 'Maria',
    color: '#c273e6',
    question: 'why does it run out of memory?',
  })
  // Strip the keys an older build would not have written.
  entry.delete('reasoning')
  entry.delete('thoughtMs')
  getChat(doc).push([entry])

  let updates = 0
  doc.on('update', () => updates++)
  const snapshot = readChatEntry(entry)

  assert.equal(updates, 0, 'reading a turn produced a document update')
  assert.equal(snapshot.reasoning, '')
  assert.equal(snapshot.thoughtMs, null)
})

/* ------------------------------------------------ ячейки бывают не только с кодом */

test('переписывание текстовой ячейки берёт markdown-заграждение', () => {
  /*
   * Ровно та ошибка, из-за которой предложение для текстовой ячейки не
   * рождалось вовсе: набор языков знал только про Python, ответ приходил
   * помеченным markdown, и патч не извлекался — запрос уходил, ответ ложился
   * в тред, а под ячейкой не появлялось ничего. Со стороны комнаты это
   * выглядело так, будто правка работает только для кода.
   */
  const answer = 'Сокращаю до одной строки.\n\n```markdown\n# Привет\n```'
  assert.equal(lastCodeBlock(answer, 'markdown'), '# Привет')
  assert.equal(lastCodeBlock(answer, 'code'), null, 'кодовая ячейка не должна принять markdown')
})

test('текстовой ячейке годится и md, и голое заграждение', () => {
  // Модель, которую попросили «дать целиком новый текст», пишет ``` куда чаще,
  // чем ```markdown, и отказ от голого заграждения выбросил бы большую часть
  // предложений, которые комната вообще видит.
  assert.equal(lastCodeBlock('вот:\n\n```md\nтекст\n```', 'markdown'), 'текст')
  assert.equal(lastCodeBlock('вот:\n\n```\nтекст\n```', 'markdown'), 'текст')
})

test('кодовой ячейке не подсовывают пример на другом языке', () => {
  const answer = 'В оболочке:\n\n```bash\npip install torch\n```'
  assert.equal(lastCodeBlock(answer, 'code'), null)
  assert.equal(lastCodeBlock(answer, 'markdown'), null)
})

test('по умолчанию извлекается код — так зовут почти все', () => {
  assert.equal(lastCodeBlock('```python\nx = 1\n```'), 'x = 1')
})
