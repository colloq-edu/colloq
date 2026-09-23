import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import { setLocaleResolver, tr } from '../shared/i18n.js'
import type { DependencyBundle } from '../shared/dependencies.js'

let dir: string
let Card: Component<any>
let SendBox: Component<any>
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-dependency-render-'))
  async function load(name: string): Promise<Component<any>> {
    const source = await readFile(new URL(`../web/src/components/competitions/${name}.svelte`, import.meta.url), 'utf8')
    let code = compile(source, { filename: `${name}.svelte`, generate: 'server' }).js.code
    for (const [from, to] of [
      ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
      ['svelte', import.meta.resolve('svelte')],
      ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
      ['@shared/dependencies', new URL('../shared/dependencies.ts', import.meta.url).href],
      ['@/lib/entrantApi', new URL('../web/src/lib/entrantApi.ts', import.meta.url).href],
      ['@/lib/competition-words', new URL('../web/src/lib/competition-words.ts', import.meta.url).href],
    ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
    const file = path.join(dir, `${name}.mjs`)
    await writeFile(file, code)
    return (await import(pathToFileURL(file).href)).default
  }
  Card = await load('DependencyBundleCard')
  SendBox = await load('SendBox')
})
after(async () => { setLocaleResolver(() => 'ru'); if (dir) await rm(dir, { recursive: true, force: true }) })

const failed: DependencyBundle = {
  id: 'bundle', number: 1, competitionId: 'c', entrantId: 'e', revisionId: 'r',
  requirementsText: 'numpy==0', normalizedRequirements: ['numpy==0'], state: 'failed',
  packages: [], downloadBytes: 0, installedBytes: 0, contentHash: null,
  error: { code: 'conflict', line: 1, message: 'Версии несовместимы.' }, log: [], createdAt: 1, readyAt: null,
}

test('rendered requirement error separates its line label from its explanation', () => {
  const html = render(Card, { props: { bundle: failed } }).body
  const text = html.replace(/<[^>]*>/g, '')
  assert.match(text, /Строка 1: Версии несовместимы\./)
  assert.doesNotMatch(text, /Строка 1:Версии/)
})

test('inventory wording handles Russian and English package counts', () => {
  setLocaleResolver(() => 'ru')
  assert.equal(tr('dependencies.inventory', { count: 1 }), 'Полный состав базы · 1 пакет')
  assert.equal(tr('dependencies.inventory', { count: 133 }), 'Полный состав базы · 133 пакета')
  assert.equal(tr('dependencies.inventory', { count: 125 }), 'Полный состав базы · 125 пакетов')
  setLocaleResolver(() => 'en')
  assert.equal(tr('dependencies.inventory', { count: 1 }), 'Full base inventory · 1 package')
  assert.equal(tr('dependencies.inventory', { count: 2 }), 'Full base inventory · 2 packages')
  setLocaleResolver(() => 'ru')
})

for (const phone of [false, true]) {
  test(`initial upload UI offers file selection before submission (${phone ? 'phone' : 'desktop'})`, () => {
    let sent = 0
    const html = render(SendBox, { props: {
      view: { competition: { slug: 'sample', limits: { wallSeconds: 600 } } },
      mine: { accepting: 'open', leftToday: 5, perDay: 5, inFlight: 0 },
      phone, busy: false, refusal: null,
      onsend: async () => { sent += 1; return true }, onrefuse: () => {},
    } }).body
    assert.match(html, /type="file"/)
    assert.match(html, /ВЫБРАТЬ ФАЙЛ/)
    assert.doesNotMatch(html, /Отправить тетрадь/)
    assert.equal(sent, 0)
  })
}

test('unavailable execution disables file selection and explains the capability', () => {
  const html = render(SendBox, { props: {
    view: { competition: { slug: 'sample', limits: { wallSeconds: 600 } }, capabilities: { execution: { available: false, code: 'unsupported_backend', reason: 'Execution unavailable in this deployment.' } } },
    mine: { accepting: 'open', leftToday: 5, perDay: 5, inFlight: 0 },
    phone: true, busy: false, refusal: null, onsend: async () => true, onrefuse: () => {},
  } }).body
  assert.match(html, /Execution unavailable in this deployment\./)
  assert.match(html, /<button[^>]*disabled/)
})
