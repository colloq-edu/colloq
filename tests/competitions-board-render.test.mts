import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import type { CompetitionPublic } from '../shared/competitions.js'
import type { EntrantBoardLine, EntrantLeaderboard } from '../shared/competitions-entrant.js'

let dir: string
let BoardView: Component<any>
let MiniBoard: Component<any>
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-board-render-'))
  const load = async (name: string): Promise<Component<any>> => {
    const source = await readFile(new URL(`../web/src/components/competitions/${name}.svelte`, import.meta.url), 'utf8')
    let code = compile(source, { filename: `${name}.svelte`, generate: 'server' }).js.code
    for (const [from, to] of [
      ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
      ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
      ['@shared/competitions', new URL('../shared/competitions.ts', import.meta.url).href],
      ['@/lib/competition-words', new URL('../web/src/lib/competition-words.ts', import.meta.url).href],
    ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
    const file = path.join(dir, `${name}.mjs`)
    await writeFile(file, code)
    return (await import(pathToFileURL(file).href)).default
  }
  BoardView = await load('BoardView')
  MiniBoard = await load('MiniBoard')
})
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

const baseline: EntrantBoardLine = {
  place: 1, entrantId: 'baseline', name: 'Базовое решение', score: 68.9902,
  submissionId: 'baseline-submission', number: 1, chosen: false, submissions: 1, baseline: true, you: false,
}
const competition = { metric: { name: 'Score', direction: 'higher' }, publicPercent: 30 } as CompetitionPublic
function show(board: EntrantLeaderboard, phone: boolean, final = false): string {
  return render(BoardView, { props: { competition, board, phone, final, onfinal: () => {} } }).body
}
const board: EntrantLeaderboard = { public: [baseline], private: null, privateOpen: false, baselinePublic: baseline.score }

for (const phone of [false, true]) {
  test(`baseline is visible before the first participant result (${phone ? 'phone' : 'desktop'})`, () => {
    const html = show(board, phone)
    assert.match(html, /Базовое решение/)
    assert.match(html, /68\.9902/)
    assert.doesNotMatch(html, /Пока никто не дошёл до числа/)
  })
  test(`final baseline uses the private score (${phone ? 'phone' : 'desktop'})`, () => {
    const html = show({ ...board, privateOpen: true, private: [{ ...baseline, score: 62.4152 }] }, phone, true)
    assert.match(html, /Базовое решение/)
    assert.match(html, /62\.4152/)
  })
}

test('a genuinely empty board still shows its empty state', () => {
  const html = show({ ...board, public: [], baselinePublic: null }, false)
  assert.match(html, /Пока никто не дошёл до числа/)
  assert.doesNotMatch(html, /Базовое решение/)
})

test('baseline remains visible below paginated participant rows', () => {
  const people = Array.from({ length: 9 }, (_, i) => ({ ...baseline, entrantId: `p${i}`, name: `Участник ${i}`, baseline: false, score: 90 - i }))
  for (const phone of [false, true]) {
    const html = show({ ...board, public: [...people, baseline] }, phone)
    assert.match(html, /Базовое решение/)
    assert.match(html, /68\.9902/)
  }
})

test('phone and desktop both offer remaining participant rows', () => {
  const people = Array.from({ length: 9 }, (_, i) => ({ ...baseline, entrantId: `p${i}`, name: `Участник ${i}`, baseline: false, score: 90 - i }))
  for (const phone of [false, true]) {
    const html = show({ ...board, public: people }, phone)
    assert.match(html, /<button[^>]*>[\s\S]*ещё 3/i, phone ? 'phone pagination' : 'desktop pagination')
  }
})

/*
 * The final table is Kaggle's private board: the place with its shift beside
 * it, the name, the final number, the count. The shift lost its own column
 * and the public score · place its seat next to the final one (29 Sep 2026).
 */
test('the final table carries the shift next to the place and no public score', () => {
  const marfa: EntrantBoardLine = { ...baseline, entrantId: 'marfa', name: 'Марфа', baseline: false, submissions: 4 }
  const platon: EntrantBoardLine = { ...baseline, entrantId: 'platon', name: 'Платон', baseline: false, submissions: 2 }
  const both: EntrantLeaderboard = {
    public: [{ ...marfa, score: 0.91 }, { ...platon, score: 0.88 }],
    private: [{ ...platon, score: 0.87 }, { ...marfa, score: 0.86 }],
    privateOpen: true,
    baselinePublic: null,
  }
  const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
  const headers = (html: string) => (html.match(/<th[\s>]/g) ?? []).length

  const final = show(both, false, true)
  assert.equal(headers(final), 4)
  assert.doesNotMatch(text(final), /СДВИГ|ПУБЛИЧНЫЙ Score/)
  assert.match(text(final), /МЕСТО УЧАСТНИК ИТОГОВЫЙ Score ПОСЫЛОК/)
  assert.match(text(final), /1 ▲ 1 П Платон 0\.8700 2 /)
  assert.match(text(final), /2 ▼ 1 М Марфа 0\.8600 4 /)
  assert.doesNotMatch(text(final), /0\.9100|0\.8800/, 'the public numbers stay on the public tab')

  // The public table keeps its one score column, and has no shift to show.
  const open = show(both, false, false)
  assert.equal(headers(open), 4)
  assert.match(text(open), /МЕСТО УЧАСТНИК ПУБЛИЧНЫЙ Score ПОСЫЛОК/)
  assert.doesNotMatch(open, /▲|▼/)

  // The phone shows the arrow next to the place as well.
  assert.match(text(show(both, true, true)), /1 ▲ 1 П Платон 0\.8700/)
  assert.doesNotMatch(show(both, true, false), /▲|▼/)
})

/*
 * Ties share a place (29 Sep 2026): seven people with one public score read
 * "4, 5, 6, 7, 8, 9, 10" beside it, while the rules gave them one place.
 */
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
const tie = 0.6722222222222224
const person = (id: string, name: string, score: number, you = false): EntrantBoardLine =>
  ({ ...baseline, entrantId: id, name, score, baseline: false, you, submissions: 3 })

test('equal scores show one place on the board, and the baseline with the same score shows it too', () => {
  const people = [
    person('a', 'Анна', 0.9),
    person('b', 'Борис', 0.8),
    ...Array.from({ length: 4 }, (_, i) => person(`t${i}`, `Участник ${i}`, tie)),
    person('z', 'Зоя', 0.5),
  ]
  const tied = { ...baseline, score: tie }
  const both: EntrantLeaderboard = { public: [...people.slice(0, 3), tied, ...people.slice(3)], private: null, privateOpen: false, baselinePublic: tie }
  for (const phone of [false, true]) {
    const shown = text(show(both, phone))
    assert.match(shown, /1 А Анна/)
    assert.match(shown, /2 Б Борис/)
    for (let i = 0; i < 4; i++) assert.match(shown, new RegExp(`3 У Участник ${i} `), `${phone ? 'phone' : 'desktop'}: tied row ${i}`)
    assert.doesNotMatch(shown, /[4-6] У Участник/)
    // The baseline is set apart at the bottom, with the tie's place.
    assert.match(shown, /3 Базовое решение 0\.6722/)
  }
})

test('the final table\'s arrows are read off the shared places', () => {
  const pub = [
    person('a', 'Анна', 0.9),
    person('b', 'Борис', 0.8),
    person('v', 'Вера', 0.8),
    person('g', 'Глеб', 0.7),
    person('d', 'Дина', 0.6),
    person('e', 'Егор', 0.6),
  ]
  // Anna drops below the pair and the pair rises together; the second tie
  // breaks up, and only the one who fell behind gets an arrow.
  const priv = [
    person('b', 'Борис', 0.95),
    person('v', 'Вера', 0.95),
    person('a', 'Анна', 0.9),
    person('g', 'Глеб', 0.5),
    person('d', 'Дина', 0.4),
    person('e', 'Егор', 0.3),
  ]
  const board: EntrantLeaderboard = { public: pub, private: priv, privateOpen: true, baselinePublic: null }
  for (const phone of [false, true]) {
    const shown = text(show(board, phone, true))
    assert.match(shown, /1 ▲ 1 Б Борис/)
    assert.match(shown, /1 ▲ 1 В Вера/)
    assert.match(shown, /3 ▼ 2 А Анна/)
    assert.match(shown, /4 — Г Глеб/)
    // "5" in the public table for both; by row numbers Egor would have gone
    // from 6 to 6 and got no arrow for sliding from 5 to 6.
    assert.match(shown, /5 — Д Дина/)
    assert.match(shown, /6 ▼ 1 Е Егор/)
  }
})

test('the mini board folds the rows between the top and you even when a tie keeps your place small', () => {
  const lines = [
    person('a', 'Анна', 0.9),
    ...Array.from({ length: 4 }, (_, i) => person(`t${i}`, `Участник ${i}`, 0.8)),
    person('me', 'Я', 0.8, true),
  ]
  const shown = text(render(MiniBoard, { props: { lines, onopen: () => {} } }).body)
  // Top three, then "· · ·" for the two tied rows not shown, then you at the
  // tie's place: "2", not the sixth row's "6".
  assert.match(shown, /1 Анна .* 2 Участник 0 .* 2 Участник 1 .* · · · 2 Вы /)
  const near = text(render(MiniBoard, { props: { lines: [...lines.slice(0, 3), { ...lines[5] }], onopen: () => {} } }).body)
  assert.doesNotMatch(near, /· · ·/)
  assert.match(near, /2 Вы /)
})
