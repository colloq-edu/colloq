/**
 * A participant of a competition with a video card, as the pages draw it
 * (Paper 15 · G4): the «Видеокарта» row of the check conditions, the first
 * step of "how a submission is checked", and the advice after torch's own
 * out-of-memory error on the hidden test.
 *
 * What these guard: a share is said only where the server holds one (a
 * number nobody enforces is a promise to a student that breaks at the first
 * real batch), «вся карта» is said where a run has the card to itself, the
 * CPU competitions keep their conditions exactly as they were, and a blind
 * participant reads our advice — never a word of what their notebook wrote
 * on the hidden test.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from 'svelte/compiler'
import { render } from 'svelte/server'
import type { Component } from 'svelte'
import { setLocaleResolver } from '../shared/i18n.js'
import { blindAdvice, gpuCondition } from '../web/src/lib/competition-words.js'

let dir: string
const components = new Map<string, Component<any>>()
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-gpu-render-'))
  const local = (name: string) => pathToFileURL(path.join(dir, `${name}.mjs`)).href
  const sources: [string, string][] = [
    ['EnvironmentDetails', '../web/src/components/ui/EnvironmentDetails.svelte'],
    ['EnvironmentLink', '../web/src/components/ui/EnvironmentLink.svelte'],
    ...['Badge', 'StageStrip', 'DependencyBundleCard', 'SubmissionEnvironment', 'SubmissionCard', 'SubmissionRow', 'HowChecked', 'Conditions'].map(
      (name) => [name, `../web/src/components/competitions/${name}.svelte`] as [string, string],
    ),
  ]
  for (const [name, at] of sources) {
    const source = await readFile(new URL(at, import.meta.url), 'utf8')
    let code = compile(source, { filename: `${name}.svelte`, generate: 'server' }).js.code
    for (const [from, to] of [
      ['svelte/internal/server', import.meta.resolve('svelte/internal/server')],
      ['svelte', import.meta.resolve('svelte')],
      ['@/lib/entrantApi', new URL('../web/src/lib/entrantApi.ts', import.meta.url).href],
      ['@/lib/routes', new URL('../web/src/lib/routes.ts', import.meta.url).href],
      ['@shared/i18n', new URL('../shared/i18n.ts', import.meta.url).href],
      ['@shared/competitions', new URL('../shared/competitions.ts', import.meta.url).href],
      ['@shared/dependencies', new URL('../shared/dependencies.ts', import.meta.url).href],
      ['@/lib/competition-words', new URL('../web/src/lib/competition-words.ts', import.meta.url).href],
      ['@/components/ui/EnvironmentLink.svelte', local('EnvironmentLink')],
      ['./EnvironmentDetails.svelte', local('EnvironmentDetails')],
      ['./DependencyBundleCard.svelte', local('DependencyBundleCard')],
      ['./Badge.svelte', local('Badge')],
      ['./StageStrip.svelte', local('StageStrip')],
      ['./SubmissionEnvironment.svelte', local('SubmissionEnvironment')],
    ]) code = code.replaceAll(`'${from}'`, JSON.stringify(to))
    await writeFile(path.join(dir, `${name}.mjs`), code)
    components.set(name, (await import(local(name))).default)
  }
})
after(async () => {
  setLocaleResolver(() => 'ru')
  if (dir) await rm(dir, { recursive: true, force: true })
})

const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/[  ]/g, ' ')
const show = (name: string, props: Record<string, unknown>) => text(render(components.get(name)!, { props }).body)
/** The copy binds a number to its unit with non-breaking spaces; compare the words. */
const plain = (words: string | null) => (words === null ? null : words.replace(/[\u00a0\u202f]/g, ' '))

const competition = {
  slug: 'letters', environment: 'kaggle-gpu', outputPolicy: 'brief',
  limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5, gpu: true },
}

/* ------------------------------------------------------------ the words */

test('the card\'s row says the share the server holds, the whole card, or only that there is one', () => {
  // A 24 GB card shared by four: 6 141 MB each, "≈ 6 ГБ" as the server words it.
  assert.equal(plain(gpuCondition({ competition, gpuSliceMb: 6141 })), 'срез ≈ 6 ГБ · cuda:0')
  assert.equal(gpuCondition({ competition, gpuSliceMb: 24_564, gpuWholeCard: true }), 'вся карта · cuda:0')
  // The cluster's card, or a card that did not say its size: no number is promised.
  assert.equal(gpuCondition({ competition, gpuSliceMb: null }), 'есть · cuda:0')
  // A competition on the CPU keeps the conditions it always had.
  assert.equal(gpuCondition({ competition: { limits: { ...competition.limits, gpu: false } }, gpuSliceMb: null }), null)
  assert.equal(gpuCondition({ competition: { limits: { wallSeconds: 600 } } }), null, 'and so does one from before the switch')
  setLocaleResolver(() => 'en')
  assert.equal(plain(gpuCondition({ competition, gpuSliceMb: 20_389 })), 'share ≈ 19.9 GB · cuda:0')
  assert.equal(gpuCondition({ competition, gpuWholeCard: true }), 'whole card · cuda:0')
  setLocaleResolver(() => 'ru')
})

/** The capability the server sends when no card is given to submissions (capabilities.ts · evaluateCapabilities). */
const noCard = {
  execution: { available: false, code: 'gpu_unavailable', reason: 'Этому соревнованию нужна видеокарта, а посылкам соревнований на этой машине не отдана ни одна.' },
  preparation: { available: true, code: 'ok', reason: null },
}

test('with no card given to submissions the row says so, as the send box beside it does, and promises no card', () => {
  // "No card" and "size unknown" arrive as the same null share; the capability tells them apart.
  assert.equal(gpuCondition({ competition, gpuSliceMb: null, gpuWholeCard: false, capabilities: noCard }), 'посылкам пока не выдана')
  // Whatever else the view says, there is no cuda:0 to promise.
  assert.equal(gpuCondition({ competition, gpuSliceMb: 6141, gpuWholeCard: true, capabilities: noCard }), 'посылкам пока не выдана')
  // Another reason the executor is down says nothing about the card: the row stays as it was.
  const dockerDown = { ...noCard, execution: { available: false, code: 'runtime_unavailable', reason: null } }
  assert.equal(gpuCondition({ competition, gpuSliceMb: null, capabilities: dockerDown }), 'есть · cuda:0')
  // A CPU competition keeps no card row whatever the executor says.
  assert.equal(gpuCondition({ competition: { limits: { gpu: false } }, capabilities: noCard }), null)
  const value = gpuCondition({ competition, gpuSliceMb: null, capabilities: noCard })
  assert.match(show('Conditions', { competition, gpu: value }), /Видеокарта посылкам пока не выдана Интернет нет/)
  const target = { file: 'data/test.csv', rows: 2140, exampleRows: 200, replaces: true }
  assert.match(show('HowChecked', { competition, target, gpu: value }), /видеокарта — посылкам пока не выдана\./)
  setLocaleResolver(() => 'en')
  assert.equal(gpuCondition({ competition, gpuSliceMb: null, capabilities: noCard }), 'not given to submissions yet')
  setLocaleResolver(() => 'ru')
})

test('a blind failed cell shows only the advice after the sentence it repeats', () => {
  const failed = { state: 'notebookFailed' as const, participantError: 'Тетрадь упала на ячейке 7 из 14: OutOfMemoryError. Текст ошибки и вывод скрыты — проверка шла на скрытом тесте.' }
  assert.equal(blindAdvice(failed), '', 'no advice: nothing to add to the head')
  const advised = { ...failed, participantError: `${failed.participantError}\n\nУ посылки срез видеокарты 6 ГБ: уменьшите batch_size или модель.` }
  assert.equal(blindAdvice(advised), 'У посылки срез видеокарты 6 ГБ: уменьшите batch_size или модель.')
  assert.equal(blindAdvice({ ...advised, state: 'timedOut' as const }), '', 'other outcomes show their brief words whole')
  assert.equal(blindAdvice({ state: 'notebookFailed' as const, participantError: null }), '')
})

/* ----------------------------------------------------------- the screens */

test('the conditions put the card under the machine, and a CPU competition keeps its rows', () => {
  const shown = show('Conditions', { competition, gpu: 'срез ≈ 6 ГБ · cuda:0' })
  assert.match(shown, /Память · процессор 4 ГБ · 2 ядра Видеокарта срез ≈ 6 ГБ · cuda:0 Интернет нет/)
  const cpu = show('Conditions', { competition: { ...competition, environment: 'base', limits: { ...competition.limits, gpu: false } } })
  assert.doesNotMatch(cpu, /Видеокарта|cuda/)
  assert.match(cpu, /Память · процессор 4 ГБ · 2 ядра Интернет нет/)
  // The value wears the accent, as the hidden test's rows wear theirs.
  const html = render(components.get('Conditions')!, { props: { competition, gpu: 'вся карта · cuda:0' } }).body
  assert.match(html, /font-bold text-accent-text">(?:<!--[^>]*-->)?вся карта · cuda:0/)
})

test('the first step of the check names the card with the time and the memory', () => {
  const target = { file: 'data/test.csv', rows: 2140, exampleRows: 200, replaces: true }
  const shown = show('HowChecked', { competition, target, gpu: 'срез ≈ 6 ГБ · cuda:0' })
  assert.match(shown, /до 10 минут, 4 ГБ памяти; видеокарта — срез ≈ 6 ГБ · cuda:0\./)
  const cpu = show('HowChecked', { competition, target })
  assert.match(cpu, /до 10 минут, 4 ГБ памяти\./)
  assert.doesNotMatch(cpu, /видеокарта/)
})

test('a blind failure on a phone shows our advice about the share, and still no traceback', () => {
  const NOW = new Date(2026, 9, 13, 14, 40).getTime()
  const submission = {
    id: 's6', number: 6, fileName: 'resnet.ipynb', state: 'notebookFailed', acceptedAt: NOW - 5 * 60_000,
    publicScore: null, privateScore: null, chosen: false, cellsDone: 7, cellsTotal: 14, durationMs: 38_000,
    errorType: 'OutOfMemoryError', blind: true, notebook: 'sent', late: false,
    participantError: 'Тетрадь упала на ячейке 7 из 14: OutOfMemoryError. Текст ошибки и вывод скрыты — проверка шла на скрытом тесте.\n\nУ посылки срез видеокарты 6 ГБ: уменьшите batch_size или модель.',
  }
  const shown = show('SubmissionCard', {
    submission, live: null, best: false, paused: false, now: NOW, busy: false, limitMs: 600_000, notebookUrl: '/n',
    frozen: false, canChoose: true, counted: false, oncancel: () => {}, onchoose: () => {}, offQuota: true,
  })
  assert.match(shown, /ячейка 7 из 14 · OutOfMemoryError У посылки срез видеокарты 6 ГБ: уменьшите batch_size или модель\./)
  assert.doesNotMatch(shown, /Тетрадь упала на ячейке/, 'the head is the mono line, not repeated')
  // The desktop row says the same in its details (drawn on a click, so read from the file).
  const row = fs.readFileSync(new URL('../web/src/components/competitions/SubmissionRow.svelte', import.meta.url), 'utf8')
  assert.match(row, /\{:else if blindAdvice\(submission\)\}[\s\S]*?\{blindAdvice\(submission\)\}<\/p>/)
})

test('a run stopped past its share keeps its chip off the file name in the desktop row', () => {
  // «НЕ ХВАТИЛО ПАМЯТИ» is the widest word of the set: 188.4 px in the bold
  // caps of the competition scale (hse-sans 700 at 14 px, tracking 0.08em,
  // the filled chip's padding), and the 184 px lane let it run into the name.
  const WIDEST_CHIP_PX = 188.4
  const NOW = new Date(2026, 9, 13, 14, 40).getTime()
  const submission = {
    id: 's9', number: 9, fileName: 'resnet-big-batch.ipynb', state: 'outOfMemory', acceptedAt: NOW - 5 * 60_000,
    publicScore: null, privateScore: null, chosen: false, cellsDone: 7, cellsTotal: 14, durationMs: 38_000,
    errorType: null, blind: false, notebook: 'sent', late: false,
    participantError: 'Посылка заняла на видеокарте больше своего среза в 6 ГБ; её остановили на ячейке 7, чтобы не мешать соседям по карте.',
  }
  const html = render(components.get('SubmissionRow')!, {
    props: {
      submission, live: null, best: false, paused: false, now: NOW, busy: false, limitMs: 600_000, notebookUrl: '/n',
      frozen: false, oncancel: () => {}, onchoose: () => {},
    },
  }).body
  const lane = /<span class="([^"]*)">(?:\s|<!--[^>]*-->)*<span class="inline-block shrink-0 whitespace-nowrap[^"]*">(?:<!--[^>]*-->)?НЕ ХВАТИЛО ПАМЯТИ/.exec(html)
  assert.ok(lane, 'the chip stands in its lane')
  const classes = lane[1].split(/\s+/)
  // A minimum the widest chip fits with a gap to spare, and the gap itself:
  // a lane never narrower than its chip, so a wider word moves the name over.
  const min = Number(/^min-w-\[(\d+)px\]$/.exec(classes.find((name) => name.startsWith('min-w-')) ?? '')?.[1] ?? NaN)
  assert.ok(min - 12 >= WIDEST_CHIP_PX, `the lane's ${min} px leave the chip less than the 12 px gap`)
  assert.ok(classes.includes('pr-3'), 'a gap between the chip and the name whatever the chip')
  assert.ok(classes.includes('shrink-0'))
  assert.ok(!classes.some((name) => /^w-\[/.test(name)), 'not a fixed width the chip can overflow')
})
