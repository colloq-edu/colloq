/**
 * The send box says when the day's limit starts over, in the zone the server
 * counts days in — right after the number it resets, on the desktop and on a
 * phone. "Today" without a zone was three different midnights in one class.
 *
 * And what the box says after the deadline under «Поздние посылки», with a
 * hidden test, and once the day's failures reach their ceiling (Paper 07 ·
 * C1, C3): each is a moment a student decides whether to send at all.
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
import type { EntrantCompetitionView, EntrantSubmissions } from '../shared/competitions-entrant.js'

let dir: string
let SendBox: Component<any>
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-sendbox-render-'))
  const source = await readFile(new URL('../web/src/components/competitions/SendBox.svelte', import.meta.url), 'utf8')
  let code = compile(source, { filename: 'SendBox.svelte', generate: 'server' }).js.code
  for (const [from, to] of [
    ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
    ['svelte', import.meta.resolve('svelte')],
    ['@/lib/entrantApi', new URL('../web/src/lib/entrantApi.ts', import.meta.url).href],
    ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
    ['@shared/dependencies', new URL('../shared/dependencies.ts', import.meta.url).href],
    ['@/lib/competition-words', new URL('../web/src/lib/competition-words.ts', import.meta.url).href],
  ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
  const file = path.join(dir, 'SendBox.mjs')
  await writeFile(file, code)
  SendBox = (await import(pathToFileURL(file).href)).default
})
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
const view = {
  competition: { slug: 'k', scoring: 'chosen', metric: { name: 'MAPE', direction: 'lower' }, limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 } },
  capabilities: { execution: { available: true } },
} as unknown as EntrantCompetitionView
const mine = (over: Partial<EntrantSubmissions>): EntrantSubmissions => ({
  submissions: [], leftToday: 3, perDay: 5, inFlight: 0, accepting: 'open', joined: true, live: [], paused: false,
  replaceable: null, resetsAt: Date.UTC(2026, 8, 30, 21), dayZone: 'Europe/Moscow', ...over,
})
const html = (state: EntrantSubmissions, phone: boolean, extra: Record<string, unknown> = {}) =>
  render(SendBox, { props: { view, mine: state, phone, busy: false, refusal: null, onsend: async () => null, onrefuse: () => {}, ...extra } }).body
const show = (state: EntrantSubmissions, phone: boolean, extra: Record<string, unknown> = {}) => text(html(state, phone, extra))
/** A disabled button — the attribute, not the `disabled:` utility classes every button carries. */
const disabled = (body: string) => /<button[^>]*\sdisabled(?:=""|\s|>)/.test(body)

for (const phone of [false, true]) {
  test(`the limit's reset is named with its zone after the count (${phone ? 'phone' : 'desktop'})`, () => {
    const left = show(mine({}), phone)
    assert.match(left, phone
      ? /3 посылки из 5\. Лимит обновится в 00:00 GMT\+3\./
      : /сегодня осталось 3 из 5, обновится в 00:00 GMT\+3\./)
    const spent = show(mine({ leftToday: 0 }), phone)
    assert.match(spent, /На сегодня посылки кончились: 5 в день на участника\. Лимит обновится в 00:00 GMT\+3\./)
  })
}

test('no limit, no reset to name; an older server that sends none leaves the line as it was', () => {
  assert.doesNotMatch(show(mine({ leftToday: null, perDay: 0, resetsAt: null }), false), /обновится/)
  const older = show(mine({ resetsAt: undefined, dayZone: undefined }), false)
  assert.match(older, /сегодня осталось 3 из 5\./)
  assert.doesNotMatch(older, /обновится/)
})

test('the desktop strip leads with the rule, names what is free and draws the count as a meter', () => {
  const body = html(mine({}), false)
  const shown = text(body)
  assert.match(shown, /Лимит тратят только посылки с оценкой — сегодня осталось 3 из 5/)
  assert.match(shown, /Упавшие не считаются: ошибка в тетради, нехватка времени или памяти, ответ не принят, сбой проверки\./)
  assert.match(shown, /осталось 3 из 5 $/)
  // Five cells, three of them filled.
  assert.equal(body.match(/h-2 w-\[34px\] shrink-0 bg-brand-2/g)?.length, 3)
  assert.equal(body.match(/h-2 w-\[34px\] shrink-0 border border-line/g)?.length, 2)
})

for (const phone of [false, true]) {
  test(`the ceiling on failures is a quiet line, and once reached it stops the box in the door's words (${phone ? 'phone' : 'desktop'})`, () => {
    const quiet = show(mine({ failedAttempts: { used: 3, ceiling: 15 } }), phone)
    assert.match(quiet, /Неудачных попыток — не больше 15 в день; сегодня 3\./)
    assert.equal(disabled(html(mine({ failedAttempts: { used: 3, ceiling: 15 } }), phone)), false)
    const full = html(mine({ failedAttempts: { used: 15, ceiling: 15 } }), phone)
    assert.match(text(full), /Это не лимит посылок/)
    assert.match(text(full), /Счёт упавших начнётся заново в 00:00 GMT\+3\./)
    assert.equal(disabled(full), true)
  })
}

const deadline = new Date(2026, 9, 4, 12, 0).getTime()
const now = new Date(2026, 9, 4, 14, 40).getTime()
const lateView = {
  ...view,
  competition: { ...view.competition, deadlineAt: deadline, lateSubmissions: true },
} as unknown as EntrantCompetitionView

test('after the deadline the box still takes a notebook and says it will not count', () => {
  const body = html(mine({ accepting: 'late' }), false, { view: lateView, now })
  const shown = text(body)
  assert.match(shown, /Посылка после дедлайна будет проверена, но в зачёт и места не пойдёт\. Оценку увидите только вы\./)
  assert.equal(disabled(body), false)
  // The action is still there, but drawn as an outline: the standings are settled.
  assert.match(body, /border-\[1\.5px\] border-brand text-brand/)
  assert.match(shown, /Лимит тратят только посылки с оценкой/)
  assert.doesNotMatch(shown, /Приём посылок закрыт/)
})

test('a late notebook on a phone gets its own box: what it is, when the deadline passed, the count', () => {
  const shown = show(mine({ accepting: 'late', leftToday: 4 }), true, { view: lateView, now })
  assert.match(shown, /Поздняя посылка — вне зачёта/)
  assert.match(shown, /Дедлайн прошёл сегодня в 12:00\. Тетрадь проверят как обычно, оценку увидите только вы/)
  assert.match(shown, /Сегодня осталось 4 посылки из 5\. Лимит обновится в 00:00 GMT\+3\. Лимит тратят только посылки с оценкой\./)
})

test('closed for good, the box promises nothing', () => {
  const body = html(mine({ accepting: 'closed' }), false, { view: lateView, now })
  assert.equal(disabled(body), true)
  assert.doesNotMatch(text(body), /Лимит тратят/)
  assert.match(text(body), /Приём посылок закрыт/)
})

test('with a hidden test the box names it where the notebook is chosen', () => {
  const sealed = { ...view, files: [], sealedFiles: [{ name: 'test.csv', rows: 2000, replaces: 'test.csv', columns: null }] } as unknown as EntrantCompetitionView
  assert.match(show(mine({}), false, { view: sealed }), /Для проверки тетрадь должна создать файл submission\.csv\. При проверке data\/test\.csv — скрытый тест\./)
  assert.match(show(mine({}), true, { view: sealed }), /Тетрадь должна создать submission\.csv\. При проверке data\/test\.csv — скрытый тест\./)
  assert.doesNotMatch(show(mine({}), false), /скрытый тест/)
})
