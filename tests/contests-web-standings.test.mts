/**
 * The contest board as it is drawn (StandingsTable.svelte), rendered on the
 * server: K3 (ICPC with a freeze), K4 (IOI), the phone and the projector (K6).
 *
 * The component is the one the participant's leaderboard, the projector and
 * the teacher's console all draw, so what it prints is what three screens
 * print. Places come from the server and must be printed as given — distinct,
 * the earlier one higher (the owner's rule, 30.09.2026) — never renumbered
 * here; a frozen cell must say «?» and nothing of its verdict.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import { setLocaleResolver } from '../shared/i18n.js'
import type { StandingCell, StandingRow } from '../shared/contests.js'
import type { EntrantStandings } from '../shared/contests-entrant.js'

let dir: string
let Table: Component<any>
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-contest-board-'))
  const source = await readFile(new URL('../web/src/components/contests/StandingsTable.svelte', import.meta.url), 'utf8')
  let code = compile(source, { filename: 'StandingsTable.svelte', generate: 'server' }).js.code
  for (const [from, to] of [
    ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
    ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
    ['@/lib/competition-words', new URL('../web/src/lib/competition-words.ts', import.meta.url).href],
    ['@/lib/contest-words', new URL('../web/src/lib/contest-words.ts', import.meta.url).href],
  ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
  assert.doesNotMatch(code, /from '@/, 'the render test resolves every import of the board')
  const file = path.join(dir, 'StandingsTable.mjs')
  await writeFile(file, code)
  Table = (await import(pathToFileURL(file).href)).default
})
after(async () => {
  setLocaleResolver(() => 'ru')
  if (dir) await rm(dir, { recursive: true, force: true })
})

/** The visible text: tags out, the screen reader's words out, spaces squeezed. */
function seen(html: string): string {
  return html
    .replace(/<span class="sr-only">[^<]*<\/span>/g, ' ')
    .replace(/<!--[^>]*-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const cell = (over: Partial<StandingCell> = {}): StandingCell => ({
  solved: false,
  attempts: 0,
  minutes: null,
  first: false,
  pending: 0,
  frozen: 0,
  score: null,
  tried: false,
  ...over,
})
const solved = (minutes: number, attempts = 0, first = false) => cell({ solved: true, minutes, attempts, first, tried: true })
const person = (place: number, id: string, name: string, cells: StandingCell[], solvedCount: number, penalty: number): StandingRow => ({
  place,
  entrantId: id,
  name,
  cells,
  solved: solvedCount,
  penalty,
  score: solvedCount,
  improvedAt: null,
})

const ICPC: EntrantStandings = {
  rules: 'icpc',
  problems: ['A', 'B', 'C'].map((letter) => ({ id: `p${letter}`, letter, title: `Задача ${letter}`, maxScore: 100 })),
  rows: [
    person(1, 'marfa', 'Марфа Соколова', [solved(9, 0, true), solved(31, 1), cell({ attempts: 3, tried: true })], 2, 100),
    person(2, 'daniil', 'Даниил Орлов', [solved(12), solved(25, 0, true), cell({ frozen: 2, tried: true })], 2, 117),
    person(3, 'timur', 'Тимур Ахметов', [solved(12), cell({ attempts: 2, tried: true }), cell({ pending: 1, tried: true })], 1, 12),
  ],
  totals: [
    { solved: 3, tried: 3, attempts: 3 },
    { solved: 2, tried: 3, attempts: 5 },
    { solved: 0, tried: 3, attempts: 6 },
  ],
  frozen: true,
  freezeAt: Date.UTC(2026, 9, 30, 11, 30),
  me: 'timur',
  penaltyMinutes: 20,
  startsAt: Date.UTC(2026, 9, 30, 10, 0),
}

function show(props: Record<string, unknown>): string {
  return render(Table, { props: { standings: ICPC, ...props } }).body
}

test('an ICPC board: places as given, «+» and «+2» over the minutes, «−3» in red, the totals row', () => {
  const text = seen(show({ me: 'timur' }))
  assert.match(text, /МЕСТО УЧАСТНИК A B C РЕШЕНО ШТРАФ/)
  assert.match(text, /1 Марфа Соколова \+ 0:09 \+1 0:31 −3 2 100/)
  assert.match(text, /2 Даниил Орлов \+ 0:12 \+ 0:25 \? 2 поп\. 2 117/)
  assert.match(text, /РЕШИЛИ \/ ПОПЫТОК 3 \/ 3 2 \/ 5 0 \/ 6/)
})

test('the first solve is solid, a later one is a tint, and the freeze is grey with no verdict', () => {
  const html = show({})
  // Marfa's A is the first solve: solid green; Daniil's A is a tint (laid over the ground, so the
  // viewer's lifted row does not grey it).
  assert.match(html, /bg-positive [^"]*"[^>]*title="[^"]*первым/)
  assert.match(html, /bg-canvas shadow-\[inset_0_0_0_100px_rgb\(var\(--positive\)\/0\.1\)\][^"]*"[^>]*title="решено, 0:12/)
  // The frozen cell: «?» and the count of tries — the danger and the accent are not there.
  const frozen = html.slice(html.indexOf('заморожено, попыток: 2') - 400, html.indexOf('заморожено, попыток: 2'))
  assert.match(frozen, /bg-raised/)
  assert.doesNotMatch(frozen, /bg-danger|border-accent/)
})

test('the viewer’s row is lifted, marked «ВЫ», and its own run shows the test it is on', () => {
  const html = show({ me: 'timur', pending: { pC: 7 } })
  const rows = html.split('<tr').filter((part) => part.includes('Тимур Ахметов'))
  assert.equal(rows.length, 1)
  assert.match(rows[0], /^[^>]*bg-raised/, 'the row is lifted')
  assert.match(rows[0], /aria-current="true"/)
  assert.match(seen(rows[0]), /3 Тимур Ахметов ВЫ \+ 0:12 −2 … тест 7 1 12/)
  // Another person's pending cell never shows a test number: only the viewer knows their own.
  const other = seen(show({ me: 'marfa', pending: { pC: 7 } }))
  assert.doesNotMatch(other, /тест 7/)
  assert.doesNotMatch(seen(show({ me: null })), /ВЫ/, 'the panel passes no viewer')
})

test('«Показать ещё» offers the rest of a long board with the range it covers', () => {
  const rows = Array.from({ length: 34 }, (_, i) => person(i + 1, `e${i}`, `Участник ${i + 1}`, [cell(), cell(), cell()], 0, 0))
  const text = seen(show({ standings: { ...ICPC, rows }, limit: 6 }))
  assert.match(text, /6 Участник 6/)
  assert.doesNotMatch(text, /7 Участник 7 /)
  assert.match(text, /7–34 Показать ещё 28 участников/)
  // «Рядом со мной»: three on either side of the viewer, and no «show more».
  const near = seen(show({ standings: { ...ICPC, rows }, me: 'e19', near: true, limit: 6 }))
  for (const place of [17, 18, 19, 20, 21, 22, 23]) assert.match(near, new RegExp(`${place} Участник ${place}`))
  assert.doesNotMatch(near, /16 Участник 16|24 Участник 24|Показать ещё/)
})

test('distinct places are printed as the server numbered them, ties included', () => {
  const tie = Array.from({ length: 4 }, (_, i) => person(i + 1, `t${i}`, `Ничья ${i}`, [solved(30), cell(), cell()], 1, 30))
  const text = seen(show({ standings: { ...ICPC, rows: tie } }))
  assert.match(text, /1 Ничья 0 .* 2 Ничья 1 .* 3 Ничья 2 .* 4 Ничья 3/)
})

test('an IOI board: «из 100» under the letter, the full score solid, a part with its bar, the sum', () => {
  const ioi: EntrantStandings = {
    ...ICPC,
    rules: 'ioi',
    frozen: false,
    freezeAt: null,
    rows: [
      { ...person(1, 'anna', 'Анна Ким', [cell({ solved: true, score: 100, tried: true }), cell({ score: 75, tried: true }), cell({ score: 0, attempts: 1, tried: true })], 1, 0), score: 175 },
    ],
  }
  const html = show({ standings: ioi })
  const text = seen(html)
  assert.match(text, /МЕСТО УЧАСТНИК A из 100 B из 100 C из 100 СУММА/)
  assert.match(text, /1 Анна Ким 100 75 0 175/)
  assert.match(html, /style="width: 75%;?"/, 'the bar is as long as the share')
  assert.doesNotMatch(text, /РЕШЕНО|ШТРАФ/)
  assert.match(text, /Группа тестов приносит свои баллы/)
})

test('the legend names the freeze only when the board is frozen, and the tie rule carries the penalty', () => {
  const frozen = seen(show({}))
  assert.match(frozen, /первым решил задачу .* заморожено/)
  assert.match(frozen, /плюс 20 за каждую неверную попытку/)
  assert.doesNotMatch(seen(show({ standings: { ...ICPC, frozen: false } })), /заморожено(?! ,)/)
  assert.doesNotMatch(seen(show({ legend: false })), /первым решил задачу/)
})

test('the projector: no avatars, no «ВЫ», no totals or legend, the rows that fit and a count of the rest', () => {
  const rows = Array.from({ length: 12 }, (_, i) => person(i + 1, `e${i}`, `Участник ${i + 1}`, [cell(), cell(), cell()], 0, 0))
  const html = show({ standings: { ...ICPC, rows }, projector: true, me: 'e0', limit: 10 })
  const text = seen(html)
  assert.doesNotMatch(html, /rounded-full/, 'no avatars on the projector')
  assert.doesNotMatch(text, /ВЫ|РЕШИЛИ|первым решил/)
  assert.match(text, /10 Участник 10/)
  assert.doesNotMatch(text, /11 Участник 11/)
  assert.match(text, /и ещё 2 участника ниже/)
  assert.match(html, /text-\[34px\]/, 'the projector type')
})

test('a phone keeps the place and the name in one sticky column', () => {
  const html = show({ me: 'timur', phone: true })
  assert.match(html, /sticky left-0/)
  assert.match(seen(html), /МЕСТО · УЧАСТНИК A B C/)
  assert.match(seen(html), /3 Тимур Ахметов ВЫ/)
})

test('an empty board says it will fill, in English too', () => {
  assert.match(seen(show({ standings: { ...ICPC, rows: [], totals: [] } })), /В таблице пока никого/)
  setLocaleResolver(() => 'en')
  try {
    const text = seen(show({ me: 'timur' }))
    assert.match(text, /PLACE PARTICIPANT A B C SOLVED PENALTY/)
    assert.match(text, /2 Daniil|Даниил Орлов \+ 0:12 \+ 0:25 \? 2 tries/)
    assert.match(text, /3 Тимур Ахметов YOU/)
  } finally {
    setLocaleResolver(() => 'ru')
  }
})
