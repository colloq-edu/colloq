import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'

let dir: string
const components = new Map<string, Component<any>>()
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-counted-render-'))
  for (const name of ['Badge', 'StageStrip', 'DependencyBundleCard', 'SubmissionEnvironment', 'SubmissionRow', 'SubmissionCard']) {
    const source = await readFile(new URL(`../web/src/components/competitions/${name}.svelte`, import.meta.url), 'utf8')
    let code = compile(source, { filename: `${name}.svelte`, generate: 'server' }).js.code
    for (const [from, to] of [
      ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
      ['svelte', import.meta.resolve('svelte')],
      ['@/lib/entrantApi', new URL('../web/src/lib/entrantApi.ts', import.meta.url).href],
      ['./DependencyBundleCard.svelte', pathToFileURL(path.join(dir, 'DependencyBundleCard.mjs')).href],
      ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
      ['@shared/competitions', new URL('../shared/competitions.ts', import.meta.url).href],
      ['@shared/dependencies', new URL('../shared/dependencies.ts', import.meta.url).href],
      ['@/lib/competition-words', new URL('../web/src/lib/competition-words.ts', import.meta.url).href],
      ['./Badge.svelte', pathToFileURL(path.join(dir, 'Badge.mjs')).href],
      ['./StageStrip.svelte', pathToFileURL(path.join(dir, 'StageStrip.mjs')).href],
      ['./SubmissionEnvironment.svelte', pathToFileURL(path.join(dir, 'SubmissionEnvironment.mjs')).href],
    ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
    const file = path.join(dir, `${name}.mjs`)
    await writeFile(file, code)
    components.set(name, (await import(pathToFileURL(file).href)).default)
  }
})
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

const submission = { id: 's1', number: 1, fileName: 'test.ipynb', state: 'scored', acceptedAt: 1, publicScore: 1, privateScore: null, chosen: true, cellsDone: 1, cellsTotal: 1, durationMs: 1 }
for (const name of ['SubmissionRow', 'SubmissionCard']) test(`${name} marks the counted result instead of an ignored manual choice`, () => {
  const props = { submission, live: null, best: false, paused: false, now: 10, busy: false, limitMs: 1000, notebookUrl: '', frozen: false, canChoose: false, counted: false, oncancel: () => {}, onchoose: () => {} }
  const html = render(components.get(name)!, { props }).body
  assert.doesNotMatch(html, /в зачёт|Выбрать/i)
  const counted = render(components.get(name)!, { props: { ...props, submission: { ...submission, chosen: false }, counted: true } }).body
  assert.match(counted, /в зачёт/i)
})

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
const rowProps = { live: null, best: false, paused: false, now: 10, busy: false, limitMs: 1000, notebookUrl: '', frozen: false, canChoose: false, counted: false, oncancel: () => {}, onchoose: () => {} }

for (const name of ['SubmissionRow', 'SubmissionCard']) test(`${name} leads with the person's own ordinal and keeps the competition's number beside it`, () => {
  const props = { ...rowProps, submission: { ...submission, number: 28, chosen: false } }
  const shown = text(render(components.get(name)!, { props: { ...props, ordinal: 3 } }).body)
  // The phone card has room for the word; the desktop column holds the ordinal alone.
  assert.match(shown, name === 'SubmissionCard' ? /3-я посылка #28/ : /3-я #28/)
  // Without an ordinal the row still names itself by the competition's number.
  const bare = text(render(components.get(name)!, { props }).body)
  assert.match(bare, /#28/)
  assert.doesNotMatch(bare, /3-я/)
})

for (const name of ['SubmissionRow', 'SubmissionCard']) test(`${name} says when a finished submission did not count toward the limit`, () => {
  const dead = { ...submission, state: 'notebookFailed', chosen: false, cellsDone: 0, cellsTotal: 0, publicScore: null, participantError: null }
  const props = { ...rowProps, submission: dead }
  assert.match(text(render(components.get(name)!, { props: { ...props, offQuota: true } }).body), /не в счёт лимита/)
  assert.doesNotMatch(text(render(components.get(name)!, { props }).body), /в счёт лимита/)
})

for (const name of ['SubmissionRow', 'SubmissionCard']) test(`${name} offers a scored run's executed notebook only when there is one`, () => {
  const props = { ...rowProps, notebookUrl: '/api/k/competitions/sample/submissions/s1/notebook', submission: { ...submission, chosen: false } }
  const executed = render(components.get(name)!, { props: { ...props, submission: { ...props.submission, notebook: 'executed' } } }).body
  assert.match(text(executed), /Скачать тетрадь с выводом/)
  assert.match(executed, /href="\/api\/k\/competitions\/sample\/submissions\/s1\/notebook"/)
  // No executed copy (or no answer from the disk): no promise of outputs.
  for (const notebook of ['sent', null, undefined]) {
    assert.doesNotMatch(text(render(components.get(name)!, { props: { ...props, submission: { ...props.submission, notebook } } }).body), /с выводом/, String(notebook))
  }
})
