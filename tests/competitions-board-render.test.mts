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
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-board-render-'))
  const source = await readFile(new URL('../web/src/components/competitions/BoardView.svelte', import.meta.url), 'utf8')
  let code = compile(source, { filename: 'BoardView.svelte', generate: 'server' }).js.code
  for (const [from, to] of [
    ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
    ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
    ['@shared/competitions', new URL('../shared/competitions.ts', import.meta.url).href],
    ['@/lib/competition-words', new URL('../web/src/lib/competition-words.ts', import.meta.url).href],
  ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
  const file = path.join(dir, 'board.mjs')
  await writeFile(file, code)
  BoardView = (await import(pathToFileURL(file).href)).default
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
