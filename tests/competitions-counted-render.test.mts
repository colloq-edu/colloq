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
