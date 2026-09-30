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
 * A tie is ranked, not shared (30 Sep 2026): for a day seven people with one
 * public score all read "4", and the teacher asked for places the way Kaggle
 * gives them — "4, 5, 6, 7, 8, 9, 10", the earlier submission higher. The
 * rows arrive from the server in that order; the screens number them.
 */
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
const tie = 0.6722222222222224
const person = (id: string, name: string, score: number, you = false): EntrantBoardLine =>
  ({ ...baseline, entrantId: id, name, score, baseline: false, you, submissions: 3 })

test('equal scores show distinct places on the board in the order they were sent, and the baseline with the same score shows the one it would take', () => {
  const people = [
    person('a', 'Анна', 0.9),
    person('b', 'Борис', 0.8),
    ...Array.from({ length: 4 }, (_, i) => person(`t${i}`, `Участник ${i}`, tie)),
    person('z', 'Зоя', 0.5),
  ]
  const tied = { ...baseline, score: tie }
  // The baseline was sent after "Участник 0" and before the other three.
  const both: EntrantLeaderboard = { public: [...people.slice(0, 3), tied, ...people.slice(3)], private: null, privateOpen: false, baselinePublic: tie }
  for (const phone of [false, true]) {
    const where = phone ? 'phone' : 'desktop'
    const shown = text(show(both, phone))
    assert.match(shown, /1 А Анна/)
    assert.match(shown, /2 Б Борис/)
    for (let i = 0; i < 4; i++) assert.match(shown, new RegExp(` ${3 + i} У Участник ${i} `), `${where}: tied row ${i}`)
    assert.match(shown, /3 У Участник 0 .* 4 У Участник 1 .* 5 У Участник 2 .* 6 У Участник 3 /, `${where}: the tie in the order it was sent`)
    // Nobody after the first of the tie reads its "3".
    assert.doesNotMatch(shown, /3 У Участник [1-3]/)
    // The baseline is set apart at the bottom, with the place it would take:
    // after the three above it, two with better scores and "Участник 0", who
    // sent the same score earlier.
    assert.match(shown, /4 Базовое решение 0\.6722/)
    // And the note under the table names the rule the numbers follow.
    assert.match(shown, /При одинаковом результате выше посылка, отправленная раньше\./)
  }
})

test("the final table's arrows are the difference of the places the two tables print", () => {
  const pub = [
    person('a', 'Анна', 0.9),
    person('b', 'Борис', 0.8),
    person('v', 'Вера', 0.8),
    person('g', 'Глеб', 0.7),
    { ...baseline, score: 0.65 },
    person('d', 'Дина', 0.6),
    person('e', 'Егор', 0.6),
  ]
  // Anna drops below the pair, and each of the pair rises one step, still in
  // the order they were sent; the second tie breaks up the way it already
  // stood, and neither of the two moves. The baseline stands elsewhere in
  // each table and moves nobody's arrow.
  const priv = [
    person('b', 'Борис', 0.95),
    person('v', 'Вера', 0.95),
    person('a', 'Анна', 0.9),
    { ...baseline, score: 0.62 },
    person('g', 'Глеб', 0.5),
    person('d', 'Дина', 0.4),
    person('e', 'Егор', 0.3),
  ]
  const board: EntrantLeaderboard = { public: pub, private: priv, privateOpen: true, baselinePublic: 0.65 }
  for (const phone of [false, true]) {
    const shown = text(show(board, phone, true))
    assert.match(shown, /1 ▲ 1 Б Борис/)
    assert.match(shown, /2 ▲ 1 В Вера/)
    assert.match(shown, /3 ▼ 2 А Анна/)
    assert.match(shown, /4 — Г Глеб/)
    // "5" and "6" in the public table already, by time: with one shared "5"
    // there, Egor got an arrow down for keeping his row.
    assert.match(shown, /5 — Д Дина/)
    assert.match(shown, /6 — Е Егор/)
    // The baseline row shows the place it would take in the final table, and
    // no arrow of its own.
    assert.match(shown, /4 Базовое решение 0\.6200/)
  }
})

test('the mini board folds the rows between the top and you, and in a tie you read your own place, not the first of the tie', () => {
  const lines = [
    person('a', 'Анна', 0.9),
    ...Array.from({ length: 4 }, (_, i) => person(`t${i}`, `Участник ${i}`, 0.8)),
    person('me', 'Я', 0.8, true),
  ]
  const shown = text(render(MiniBoard, { props: { lines, onopen: () => {} } }).body)
  // Top three, then "· · ·" for the two tied rows not shown, then you at the
  // place the full table gives you: sent last of the five with 0.8, "6", not
  // the "2" the tie starts at.
  assert.match(shown, /1 Анна .* 2 Участник 0 .* 3 Участник 1 .* · · · 6 Вы /)
  assert.doesNotMatch(shown, /Участник [23]/)
  const near = text(render(MiniBoard, { props: { lines: [...lines.slice(0, 3), { ...lines[5] }], onopen: () => {} } }).body)
  // Right after the top three nothing is left out, so nothing is folded.
  assert.doesNotMatch(near, /· · ·/)
  assert.match(near, /3 Участник 1 .* 4 Вы /)
})

test('the table says other addresses are shortened only when it shows one', () => {
  const masked = [
    { ...person('a', 'pet…@hse.ru', 0.9) },
    { ...person('me', 'ivanov@hse.ru', 0.8, true) },
  ]
  const shown = text(show({ ...board, public: masked }, false))
  assert.match(shown, /pet…@hse\.ru/)
  assert.match(shown, /ivanov@hse\.ru/)
  assert.match(shown, /Почты других участников показаны сокращённо/)
  // Usernames, and one's own full address, have nothing shortened.
  const plain = text(show({ ...board, public: [person('t', '@tele_gram', 0.9), person('me', 'ivanov@hse.ru', 0.8, true)] }, false))
  assert.doesNotMatch(plain, /сокращённо/)
})

test('the mini board of a board closed to this visitor says so instead of "nobody has a score"', () => {
  const shown = text(render(MiniBoard, { props: { lines: [], closed: true, onopen: () => {} } }).body)
  assert.match(shown, /Лидерборд видят только участники/)
  assert.doesNotMatch(shown, /Пока никто не дошёл до числа/)
})
