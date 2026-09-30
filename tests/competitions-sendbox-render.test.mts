/**
 * The send box says when the day's limit starts over, in the zone the server
 * counts days in — right after the number it resets, on the desktop and on a
 * phone. "Today" without a zone was three different midnights in one class.
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
const show = (state: EntrantSubmissions, phone: boolean) =>
  text(render(SendBox, { props: { view, mine: state, phone, busy: false, refusal: null, onsend: async () => null, onrefuse: () => {} } }).body)

for (const phone of [false, true]) {
  test(`the limit's reset is named with its zone after the count (${phone ? 'phone' : 'desktop'})`, () => {
    const left = show(mine({}), phone)
    assert.match(left, /3 посылки из 5\. Лимит обновится в 00:00 GMT\+3\./)
    const spent = show(mine({ leftToday: 0 }), phone)
    assert.match(spent, /На сегодня посылки кончились: 5 в день на участника\. Лимит обновится в 00:00 GMT\+3\./)
  })
}

test('no limit, no reset to name; an older server that sends none leaves the line as it was', () => {
  assert.doesNotMatch(show(mine({ leftToday: null, perDay: 0, resetsAt: null }), false), /обновится/)
  const older = show(mine({ resetsAt: undefined, dayZone: undefined }), false)
  assert.match(older, /3 посылки из 5\./)
  assert.doesNotMatch(older, /обновится/)
})
