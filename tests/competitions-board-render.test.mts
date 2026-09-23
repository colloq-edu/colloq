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
