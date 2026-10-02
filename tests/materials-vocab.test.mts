/**
 * The vocabulary of a class page (shared/materials.ts): kinds, keys, tags,
 * suggested names and the default ticks with their reasons.
 *
 * Keys are addresses (`/p/ml-strong-04/seminar`) and must never look like a
 * 0.12 step number; tags are what a course row prints, in one fixed order;
 * the default ticks lean towards leaving a file out, and always say why.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MATERIAL_KEY_RE,
  filePick,
  looksGenerated,
  looksLikeAnswers,
  materialKey,
  materialKind,
  materialRank,
  materialTags,
  mentioned,
  notebookPick,
  rosterMatch,
  suggestName,
  suggestNames,
} from '../shared/materials.js'

test('a key is never all digits, so it can never be taken for a step', () => {
  assert.equal(materialKey('02.ipynb', 'notebook'), 'notebook-02')
  assert.equal(materialKey('2026.csv', 'data'), 'data-2026')
  assert.equal(materialKey('№.pdf', 'pdf'), 'pdf')
  assert.equal(materialKey('я.pdf', 'pdf'), 'ya')
  assert.equal(materialKey('seminar.ipynb', 'notebook'), 'seminar')
  assert.equal(materialKey('Лекция 3.ipynb', 'notebook'), 'lekciya-3')
  for (const key of ['notebook-02', 'data-2026', 'pdf', 'seminar', 'lekciya-3']) {
    assert.match(key, MATERIAL_KEY_RE)
  }
  assert.doesNotMatch('12', MATERIAL_KEY_RE)
  assert.ok(materialKey(`${'очень длинное имя '.repeat(5)}.csv`, 'data').length <= 40)
})

test('clashing keys get a -2, then a -3', () => {
  const taken = new Set<string>()
  const one = materialKey('train.ipynb', 'notebook', taken)
  taken.add(one)
  const two = materialKey('data/train.csv', 'data', taken)
  taken.add(two)
  const three = materialKey('more/train.csv', 'data', taken)
  assert.deepEqual([one, two, three], ['train', 'train-2', 'train-3'])
})

test('kinds come from the file name', () => {
  assert.equal(materialKind('lecture.ipynb'), 'notebook')
  assert.equal(materialKind('slides/lecture.pdf'), 'pdf')
  assert.equal(materialKind('data/train.csv'), 'data')
  assert.equal(materialKind('data/train.parquet'), 'data')
  assert.equal(materialKind('utils.py'), 'code')
  assert.equal(materialKind('README.md'), 'text')
  assert.equal(materialKind('fig.png'), 'image')
  assert.equal(materialKind('surface.html'), 'file')
})

test('tags come out once each, in the course-row order', () => {
  const tags = materialTags([
    { kind: 'data', name: 'data/train.csv', path: 'data/train.csv' },
    { kind: 'pdf', name: 'Слайды лекции', path: 'lecture.pdf' },
    { kind: 'notebook', name: 'Семинар', path: 'seminar.ipynb' },
    { kind: 'notebook', name: 'Лекция', path: 'lecture.ipynb' },
    { kind: 'data', name: 'data/test.csv', path: 'data/test.csv' },
    { kind: 'code', name: 'utils.py', path: 'utils.py' },
    { kind: 'notebook', name: 'Домашнее задание', path: 'hw3.ipynb' },
    { kind: 'notebook', name: 'extra', path: 'extra.ipynb' },
    { kind: 'pdf', name: 'paper', path: 'paper.pdf' },
    { kind: 'image', name: 'fig.png', path: 'fig.png' },
  ])
  assert.deepEqual(tags, [
    'lecture',
    'seminar',
    'notebook',
    'homework',
    'slides',
    'pdf',
    'data',
    'code',
    'files',
  ])
})

test('names Лекция, Семинар and Домашнее задание are suggested from file names', () => {
  assert.equal(suggestName('lecture_03.ipynb'), 'Лекция')
  assert.equal(suggestName('Seminar3.ipynb'), 'Семинар')
  assert.equal(suggestName('sem03.ipynb'), 'Семинар')
  assert.equal(suggestName('homework-2.ipynb'), 'Домашнее задание')
  assert.equal(suggestName('hw2.ipynb'), 'Домашнее задание')
  assert.equal(suggestName('lecture.pdf'), 'Слайды лекции')
  assert.equal(suggestName('eda.ipynb'), 'eda')
  // Data keeps its room path: code refers to it by that.
  assert.equal(suggestName('data/train.csv'), 'data/train.csv')
  // Two lectures cannot both be «Лекция»: both fall back to their file names.
  assert.deepEqual(suggestNames(['lecture1.ipynb', 'lecture2.ipynb', 'seminar.ipynb']), [
    'lecture1',
    'lecture2',
    'Семинар',
  ])
})

test('the default order is lecture, seminar, other notebooks, homework, then files by kind', () => {
  const items = [
    { kind: 'data' as const, name: 'd.csv', path: 'd.csv' },
    { kind: 'notebook' as const, name: 'Домашнее задание', path: 'hw.ipynb' },
    { kind: 'pdf' as const, name: 'Слайды', path: 's.pdf' },
    { kind: 'notebook' as const, name: 'eda', path: 'eda.ipynb' },
    { kind: 'notebook' as const, name: 'Семинар', path: 'seminar.ipynb' },
    { kind: 'notebook' as const, name: 'Лекция', path: 'lecture.ipynb' },
  ]
  const sorted = [...items].sort((a, b) => materialRank(a) - materialRank(b)).map((m) => m.name)
  assert.deepEqual(sorted, ['Лекция', 'Семинар', 'eda', 'Домашнее задание', 'Слайды', 'd.csv'])
})

test('a leading underscore and answer-like names are left out, with the reason', () => {
  const pick = (path: string) => notebookPick({ path, empty: false, owner: null, roster: [] })
  assert.deepEqual(pick('_draft.ipynb'), { picked: false, why: 'private' })
  assert.deepEqual(pick('notes/_mine/x.ipynb'), { picked: false, why: 'private' })
  assert.deepEqual(pick('seminar_solutions.ipynb'), { picked: false, why: 'answers' })
  assert.deepEqual(pick('hw1_sol.ipynb'), { picked: false, why: 'answers' })
  assert.deepEqual(pick('Ответы.ipynb'), { picked: false, why: 'answers' })
  assert.deepEqual(pick('решение_дз.ipynb'), { picked: false, why: 'answers' })
  assert.deepEqual(pick('seminar.ipynb'), { picked: true, why: null })
  assert.ok(looksLikeAnswers('solutions.py'))
  assert.ok(!looksLikeAnswers('solver.py'))
  assert.ok(!looksLikeAnswers('console.py'))
})

test('student notebooks are recognised by their owner and by roster-like names', () => {
  assert.deepEqual(
    notebookPick({ path: 'Мой.ipynb', empty: false, owner: 'Зуев Аким', roster: [] }),
    { picked: false, why: 'student' },
  )
  assert.equal(rosterMatch('ZuevAkim_02.ipynb', ['Зуев Аким']), 'Зуев Аким')
  assert.equal(rosterMatch('akim_hw.ipynb', ['Зуев Аким']), 'Зуев Аким')
  assert.equal(rosterMatch('seminar.ipynb', ['Зуев Аким']), null)
  const roster = ['Зуев Аким']
  assert.deepEqual(notebookPick({ path: 'ZuevAkim_02.ipynb', empty: false, owner: null, roster }), {
    picked: false,
    why: 'roster',
  })
  assert.deepEqual(notebookPick({ path: 'seminar.ipynb', empty: true, owner: null, roster: [] }), {
    picked: false,
    why: 'empty',
  })
})

test('mentioned() finds a file by name, a helper by import, and a folder written as one', () => {
  assert.ok(mentioned('train_home_price.csv', "df = pd.read_csv('train_home_price.csv')"))
  assert.ok(mentioned('data/train.csv', "pd.read_csv('data/train.csv')"))
  assert.ok(mentioned('data/test.csv', "for name in os.listdir('data/'):"))
  assert.ok(mentioned('data/raw/a.csv', 'root = "data/"'))
  assert.ok(mentioned('utils.py', 'from utils import plot_curve'))
  assert.ok(mentioned('scripts/utils.py', 'import scripts.utils as u'))
  assert.ok(!mentioned('train.csv', "pd.read_csv('mytrain.csv')"))
  assert.ok(!mentioned('data/test.csv', "pd.read_csv('data/train.csv')"))
  assert.ok(!mentioned('utils.py', 'print("no imports here")'))
})

test('generated output and big files are not ticked by default', () => {
  assert.ok(looksGenerated('outputs/model.csv', 100))
  assert.ok(looksGenerated('surface.html', 5.2 * 1024 * 1024))
  assert.ok(!looksGenerated('handout.html', 20_000))
  assert.ok(looksGenerated('model.pt', 100))
  const base = { usedBy: ['seminar.ipynb'], inNotes: false, roster: [], fileLimit: 50 * 1024 * 1024 }
  assert.deepEqual(filePick({ ...base, path: 'lecture.pdf', kind: 'pdf', bytes: 5e6, usedBy: [] }), {
    picked: true,
    why: null,
  })
  assert.deepEqual(filePick({ ...base, path: 'train.csv', kind: 'data', bytes: 1e5 }), {
    picked: true,
    why: null,
  })
  assert.deepEqual(filePick({ ...base, path: 'train.csv', kind: 'data', bytes: 1e5, usedBy: [] }), {
    picked: false,
    why: 'unused',
  })
  assert.deepEqual(filePick({ ...base, path: 'big.csv', kind: 'data', bytes: 30e6 }), {
    picked: false,
    why: 'too-large',
  })
  assert.deepEqual(filePick({ ...base, path: 'huge.csv', kind: 'data', bytes: 60e6 }), {
    picked: false,
    why: 'too-large',
  })
  assert.deepEqual(filePick({ ...base, path: 'solutions.py', kind: 'code', bytes: 1e3 }), {
    picked: false,
    why: 'answers',
  })
  assert.deepEqual(filePick({ ...base, path: 'fig.png', kind: 'image', bytes: 1e4, inNotes: true }), {
    picked: false,
    why: 'image',
  })
})
