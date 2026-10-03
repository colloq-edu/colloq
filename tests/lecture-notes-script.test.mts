/**
 * The console reads a speaker note as a script, not as a document.
 *
 * Two conventions get their own shape on the console (see
 * web/src/components/lecture/notes-script.ts): an "if asked" paragraph folds
 * into a callout where it stands, and a timing remark (`*≈ 1.2 мин*`) moves
 * out of the text into the header and the plan. Both rules are narrow on
 * purpose, and both directions are checked: what must fold and what must stay
 * a line of the talk, what is a timing and what only looks like one.
 *
 * Plus the slide title the footer says "next" with, read from the PDF's text
 * runs: the largest type on the page.
 */
import './_env.mts'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  askOf,
  budgetOf,
  firstLine,
  plainLine,
  plannedSeconds,
  readNote,
  timingOf,
} from '../web/src/components/lecture/notes-script.js'
import { titleFromRuns } from '../web/src/components/lecture/slide-titles.js'

/* --------------------------------------------------------- if asked */

test('"if asked" folds in every spelling the toolbar and the hand produce', () => {
  for (const line of [
    '**Если спросят:** а если просто стереть метаданные?',
    '**Если спросят**: а если просто стереть метаданные?',
    '**Если спросят** а если просто стереть метаданные?',
    '__Если спросят:__ а если просто стереть метаданные?',
    'Если спросят: а если просто стереть метаданные?',
    'если спросят: а если просто стереть метаданные?',
    '**Если спросят: а если просто стереть метаданные?**',
    '**Если спросят** — а если просто стереть метаданные?',
  ]) {
    const ask = askOf(`${line}\nНе поможет: больница видна в самих пикселях.`)
    assert.ok(ask, `did not fold: ${line}`)
    assert.equal(ask.question, 'а если просто стереть метаданные?', line)
    assert.equal(ask.answer, 'Не поможет: больница видна в самих пикселях.', line)
  }
  // English, the other language of the product.
  assert.deepEqual(askOf('**If asked:** why not crop the label?\nThe fonts remain.'), {
    question: 'why not crop the label?',
    answer: 'The fonts remain.',
  })
  // A quoted callout counts too: `>` on every line.
  assert.deepEqual(askOf('> **Если спросят:** почему не закрасить?\n> Шрифт остаётся.'), {
    question: 'почему не закрасить?',
    answer: 'Шрифт остаётся.',
  })
  // The question may stand on its own line under the label.
  assert.deepEqual(askOf('**Если спросят:**\nпочему не закрасить?\nШрифт остаётся.'), {
    question: 'почему не закрасить?',
    answer: 'Шрифт остаётся.',
  })
})

test('a sentence that only starts like a callout stays a line of the talk', () => {
  for (const line of [
    'Если спросят, что это значит, — покажите следующий слайд.',
    'Если спросят про метку — это нормально.',
    'Потом: **Если спросят:** не здесь.',
    '*Если спросят:* курсив не считается.',
  ]) {
    assert.equal(askOf(line), null, `folded a sentence: ${line}`)
  }
})

test('callouts stay where the teacher put them, between the paragraphs around them', () => {
  const script = readNote(
    [
      'Модель не знает, что такое болезнь.',
      '',
      '*Пауза. Пусть зал сам предположит.*',
      '',
      '**Если спросят:** почему не закрасить метку?',
      'Шрифт и рамка остаются.',
      '',
      'Источник — это не метаданные.',
    ].join('\n'),
  )
  assert.deepEqual(
    script.blocks.map((block) => block.kind),
    ['text', 'ask', 'text'],
  )
  assert.equal(
    script.blocks[0].kind === 'text' && script.blocks[0].source,
    'Модель не знает, что такое болезнь.\n\n*Пауза. Пусть зал сам предположит.*',
    'a run of paragraphs is kept as one markdown text',
  )
})

test('a blank line inside a code sample does not split it into paragraphs', () => {
  const script = readNote('```python\nx = 1\n\nIf asked: y = 2\n```')
  assert.equal(script.blocks.length, 1)
  assert.equal(script.blocks[0].kind, 'text')
})

/* ----------------------------------------------------------- timing */

test('the timing remark is lifted into the header, and what follows it stays a remark', () => {
  const plain = readNote('*≈ 1.2 мин*\n\nТеперь самый коварный вид утечки.')
  assert.deepEqual(plain.timing, { seconds: 72, label: '≈ 1.2 мин' })
  assert.deepEqual(plain.blocks, [{ kind: 'text', source: 'Теперь самый коварный вид утечки.' }])

  const remark = readNote('*≈ 1.2 мин · не торопиться, это главный слайд*\n\nТекст.')
  assert.equal(remark.timing?.seconds, 72)
  assert.equal(
    remark.blocks[0].kind === 'text' && remark.blocks[0].source,
    '*не торопиться, это главный слайд*\n\nТекст.',
  )
  // Only the first timing is the slide's; a later one is just text.
  const twice = readNote('_~ 40 сек_\n\n*≈ 2 мин*')
  assert.equal(twice.timing?.seconds, 40)
  assert.equal(twice.blocks.length, 1)
})

test('only a number with a unit is a timing', () => {
  assert.equal(timingOf('*≈ 1,5 мин*')?.seconds, 90)
  assert.equal(timingOf('≈ 2 min · slowly')?.seconds, 120)
  assert.equal(timingOf('~ 45 s')?.seconds, 45)
  assert.equal(timingOf('*≈ 3 минуты*')?.seconds, 180)
  for (const line of ['≈ половина зала', '*≈ 2 месяца*', '≈ 2', 'Около 2 мин', '*≈ 0 мин*', '**≈ 1 мин**']) {
    assert.equal(timingOf(line), null, `took for a timing: ${line}`)
  }
})

test('the plan counts the timed script up to this page, and is silent for an untimed one', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `слово${i}`).join(' ')
  const notes = {
    1: '*≈ 1 мин*\n\nВступление.',
    2: words(150),
    3: '*≈ 2 мин*\n\nГлавное.',
  }
  // Page 2 has no timing and counts by its estimate: 150 words is a minute.
  assert.equal(budgetOf(notes[2]).seconds, 60)
  assert.equal(budgetOf(notes[2]).written, null)
  assert.equal(plannedSeconds(notes, 1), 60)
  assert.equal(plannedSeconds(notes, 2), 120)
  assert.equal(plannedSeconds(notes, 3), 240)
  // Nobody timed this script: no plan is made up from word counts alone.
  assert.equal(plannedSeconds({ 1: words(300), 2: words(150) }, 2), null)
})

/* ---------------------------------------------------------- preview */

test('the "next" line is words, not markup, and never the timing or an answer', () => {
  assert.equal(plainLine('## **Сначала пример**, потом [формула](https://x).'), 'Сначала пример, потом формула.')
  assert.equal(plainLine('- *не* показывать `код`'), 'не показывать код')
  assert.equal(plainLine('snake_case_name stays'), 'snake_case_name stays')
  assert.equal(
    firstLine('*≈ 1 мин*\n\n**Если спросят:** что?\nОтвет.\n\nВот как это выглядит на снимках.'),
    'Вот как это выглядит на снимках.',
  )
  assert.equal(firstLine(''), '')
})

/* ------------------------------------------------------- slide title */

test('a slide title is the largest type on the page, in reading order', () => {
  const run = (str: string, size: number) => ({ str, transform: [size, 0, 0, size, 0, 0] })
  assert.equal(
    titleFromRuns([
      run('Источник данных', 30),
      run(' ', 30),
      run('становится подсказкой', 30),
      run('Модель учит не болезнь', 16),
      run('14', 11),
    ]),
    'Источник данных становится подсказкой',
  )
  // A scanned deck has no text: no title rather than a wrong one.
  assert.equal(titleFromRuns([]), '')
  // A big section number alone says nothing as a title.
  assert.equal(titleFromRuns([run('03', 60), run('small print', 12)]), '')
  assert.ok(titleFromRuns([run('x'.repeat(400), 30)]).length <= 140)
})

/* ----------------------------------------------- the reader is wired */

function code(rel: string): string {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

test('the console reads notes through the shared renderer, inert, and starts each page at the top', () => {
  const reader = code('web/src/components/lecture/NotesReader.svelte')
  assert.match(reader, /from '@\/lib\/render\.svelte'/, 'the reader renders markdown on its own again')
  assert.match(reader, /markdown\(block\.source, \{ inert: true \}\)/)
  assert.match(reader, /scroller\.scrollTop = 0/, 'a new page opens at the previous page\'s scroll')
  assert.doesNotMatch(reader, /<textarea/, 'the console reader grew an input field')
  const render = code('web/src/lib/render.svelte.ts')
  assert.match(render, /if \(options\.inert\)/)
  // Selection belongs to the field only: the reader lies under the writing palm.
  const css = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'web/src/index.css'), 'utf8')
  assert.match(css, /\[data-pult\] textarea\.pult-prompt \{\s*user-select: text;/)
  assert.doesNotMatch(css, /\[data-pult\] \.pult-prompt \{/)
})
