/**
 * A lecture script in, a lecture script out.
 *
 * The import cuts one .md into page notes by its `##` headings, and the
 * export writes the notes back in the same shape. Both directions break
 * SILENTLY when they disagree: a script exported on Monday that comes back on
 * Tuesday glued into one note on slide 1 looks imported, and the teacher finds
 * out in class. So the round trip is checked here on the awkward notes too —
 * a heading inside a note, a code block with `## comment` lines in it, an
 * empty slide in the middle.
 *
 * And the plan: what each section would do to the slides, with the two rules
 * that keep the import from losing written text — a section over the ceiling
 * is skipped whole, never cut, and an empty one never deletes a note.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_NOTE_CHARS } from '../shared/lecture.js'
import {
  buildScript,
  countWords,
  parseScript,
  planImport,
  speakingMinutes,
} from '../shared/speaker-notes.js'

test('"## NN · Title" sections land on the numbered pages', () => {
  const sections = parseScript(
    [
      '# Лики и хаки данных',
      'Предисловие, которое не принадлежит ни одному слайду.',
      '',
      '## 01 · Лики и хаки данных',
      '',
      'Начните с вопроса залу.',
      '',
      '## 02 · Почему 99 % точности настораживает',
      'Первая строка.',
      'Вторая строка.',
      '',
      '## 14 · Источник данных становится подсказкой',
      '*≈ 1.2 мин*',
    ].join('\n'),
  )
  assert.deepEqual(
    sections.map(({ page, number, title, body }) => ({ page, number, title, body })),
    [
      { page: 1, number: 1, title: 'Лики и хаки данных', body: 'Начните с вопроса залу.' },
      {
        page: 2,
        number: 2,
        title: 'Почему 99 % точности настораживает',
        body: 'Первая строка.\nВторая строка.',
      },
      { page: 14, number: 14, title: 'Источник данных становится подсказкой', body: '*≈ 1.2 мин*' },
    ],
  )
  assert.equal(sections[2].line, 12, 'the heading line is kept for messages')
})

test('other ways of numbering are read too: "01.", "Слайд 1", "Slide 3:", "4)"', () => {
  const pages = parseScript(
    [
      '## 01. Точка',
      'a',
      '## Слайд 2',
      'b',
      '## Slide 3: Colon',
      'c',
      '## 4) Скобка',
      'd',
      '## 5 — Тире',
      'e',
      '## №6 Номер',
      'f',
    ].join('\n'),
  ).map(({ page, title }) => [page, title])
  assert.deepEqual(pages, [
    [1, 'Точка'],
    [2, ''],
    [3, 'Colon'],
    [4, 'Скобка'],
    [5, 'Тире'],
    [6, 'Номер'],
  ])
})

test('headings without numbers go by order, and continue after a numbered one', () => {
  const plain = parseScript('## Вступление\na\n## Задача\nb\n## Итог\nc').map((s) => s.page)
  assert.deepEqual(plain, [1, 2, 3])
  const mixed = parseScript('## 10 · Десятый\na\n## Без номера\nb\n## 3D-модели\nc')
  assert.deepEqual(
    mixed.map((s) => [s.page, s.number, s.title]),
    [
      [10, 10, 'Десятый'],
      [11, null, 'Без номера'],
      // A digit glued to a letter is a word, not a slide number.
      [12, null, '3D-модели'],
    ],
  )
})

test('a script written with "#" only is cut by "#"; with "##" a "#" line is a chapter', () => {
  assert.deepEqual(
    parseScript('# 1 · Один\na\n# 2 · Два\nb').map((s) => [s.page, s.body]),
    [
      [1, 'a'],
      [2, 'b'],
    ],
  )
  // The chapter line closes the section above instead of ending up in its note.
  assert.deepEqual(
    parseScript('## 1 · Один\na\n# Часть 2\n## 2 · Два\nb').map((s) => [s.page, s.body]),
    [
      [1, 'a'],
      [2, 'b'],
    ],
  )
  // Deeper headings are content.
  assert.equal(parseScript('## 1\n### Подзаголовок\nтекст')[0].body, '### Подзаголовок\nтекст')
})

test('a "##" inside a code fence is code, not a new section', () => {
  const sections = parseScript('## 1 · Код\n```python\n## шаг 1\nx = 1\n```\n## 2 · Дальше\nb')
  assert.deepEqual(
    sections.map((s) => s.page),
    [1, 2],
  )
  assert.equal(sections[0].body, '```python\n## шаг 1\nx = 1\n```')
})

test('Windows line ends and a BOM do not leak into the notes', () => {
  const [first] = parseScript('﻿## 01 · Заголовок\r\nстрока один\r\nстрока два\r\n')
  assert.equal(first.page, 1)
  assert.equal(first.title, 'Заголовок')
  assert.equal(first.body, 'строка один\nстрока два')
})

test('the plan: new, replace, same, too long, no slide, empty, duplicate', () => {
  const long = 'ы'.repeat(MAX_NOTE_CHARS + 1)
  const script = [
    '## 01 · Новый',
    'новая заметка',
    '## 02 · Замена',
    'другая заметка',
    '## 03 · Без изменений',
    'та же заметка',
    '## 04 · Длинный',
    long,
    '## 05 · Пустой',
    '',
    '## 01 · Повтор',
    'второй раздел для первого слайда',
    '## 51 · Вопросы и ссылки',
    'слайда нет',
  ].join('\n')
  const plan = planImport(parseScript(script), 50, {
    2: 'старая заметка',
    3: 'та же заметка',
    4: 'короткая',
    5: 'останется',
  })
  assert.deepEqual(
    plan.rows.map((row) => [row.page, row.status]),
    [
      [1, 'new'],
      [2, 'replace'],
      [3, 'same'],
      [4, 'too-long'],
      [5, 'empty'],
      [1, 'duplicate'],
      [51, 'no-slide'],
    ],
  )
  assert.equal(plan.rows[3].chars, MAX_NOTE_CHARS + 1, 'the length is shown, not hidden')
  // Only what changes something goes to the server. The long section is not
  // cut to fit, and the empty one does not delete slide 5's note.
  assert.deepEqual(plan.writes, { 1: 'новая заметка', 2: 'другая заметка' })
  assert.deepEqual(plan.counts, {
    new: 1,
    replace: 1,
    same: 1,
    'too-long': 1,
    'no-slide': 1,
    empty: 1,
    duplicate: 1,
  })
})

test('a note of exactly the ceiling goes in; one character more does not', () => {
  const exact = 'а'.repeat(MAX_NOTE_CHARS)
  const plan = planImport(parseScript(`## 1\n${exact}\n## 2\n${exact}б`), 2, {})
  assert.deepEqual(
    plan.rows.map((row) => row.status),
    ['new', 'too-long'],
  )
  assert.deepEqual(Object.keys(plan.writes), ['1'])
})

test('export → import gives back every note, the awkward ones too', () => {
  const notes: Record<number, string> = {
    1: '*≈ 1.2 мин · не торопиться*\n\nМодель видит не только снимок.',
    2: '## Заголовок внутри заметки\nи текст под ним\n# и ещё один',
    // Slide 3 has no note: the export lists it, the import must not invent one.
    4: '```python\n## шаг 1\nx = 1\n```',
    5: '- пункт один\n- пункт два\n\n> цитата\n\n**Если спросят:** а если закрасить метку?\nНе поможет.',
  }
  const script = buildScript({
    notes,
    pages: 5,
    titles: { 1: 'Лики и хаки', 2: 'Строка\nс переносом' },
    heading: 'lecture-poster.pdf',
  })
  assert.match(script, /^# lecture-poster\.pdf\n\n## 01 · Лики и хаки\n/)
  assert.match(script, /\n## 02 · Строка с переносом\n/, 'a title stays on its heading line')
  assert.match(script, /\n## 03\n/, 'a slide without a note still gets its heading')
  const plan = planImport(parseScript(script), 5, {})
  assert.deepEqual(plan.writes, notes)
  assert.equal(plan.counts.empty, 1)
})

test('export pads numbers to the widest one, so headings sort', () => {
  const script = buildScript({ notes: { 7: 'x', 120: 'y' }, pages: 120 })
  assert.match(script, /\n## 007\n\nx\n/)
  assert.match(script, /\n## 120\n\ny\n$/)
  assert.deepEqual(planImport(parseScript(script), 120, {}).writes, { 7: 'x', 120: 'y' })
})

test('an open code fence in a note does not swallow the slides after it', () => {
  const notes = { 1: '```\nкод без конца', 2: 'вторая' }
  const back = planImport(parseScript(buildScript({ notes, pages: 2 })), 2, {}).writes
  assert.equal(back[2], 'вторая')
  assert.equal(back[1], '```\nкод без конца\n```')
})

test('words are counted without the markup, minutes at a lecture pace', () => {
  assert.equal(countWords('- раз **два**\n- три\n\n> четыре `код` пять\n\n## шесть'), 6)
  assert.equal(countWords('$x^2$ и — 42'), 3)
  assert.equal(speakingMinutes(186), 1.2)
  assert.equal(speakingMinutes(0), 0)
})
