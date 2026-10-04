/**
 * The participant's screens after the deadline and with a hidden test, as
 * they are drawn (Paper 07 · C1, C3).
 *
 * What these guard is what a student must never be told: that a late
 * submission counts — a "counted" mark or a "Count this one" button on it —
 * that a failure cost them a submission, or a word of a blind run's own text.
 * And what they must be told before the first submission: that the example
 * file is swapped for a hidden test of another size at the same path.
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

let dir: string
const components = new Map<string, Component<any>>()
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'colloq-late-render-'))
  const local = (name: string) => pathToFileURL(path.join(dir, `${name}.mjs`)).href
  const sources: [string, string][] = [
    ['EnvironmentDetails', '../web/src/components/ui/EnvironmentDetails.svelte'],
    ['EnvironmentLink', '../web/src/components/ui/EnvironmentLink.svelte'],
    ...['Badge', 'StageStrip', 'DependencyBundleCard', 'SubmissionEnvironment', 'SubmissionRow', 'SubmissionCard',
      'DataFiles', 'HowChecked', 'Conditions', 'MiniBoard', 'PageHeader'].map(
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

const NOW = new Date(2026, 9, 4, 14, 40).getTime()
const DEADLINE = new Date(2026, 9, 4, 12, 0).getTime()
const submission = {
  id: 's17', number: 17, fileName: 'door_events_v6.ipynb', state: 'scored', acceptedAt: NOW - 50 * 60_000,
  publicScore: 0.9261, privateScore: null, chosen: false, cellsDone: 15, cellsTotal: 15, durationMs: 188_000,
  participantError: null, late: true,
}
const rowProps = {
  live: null, best: false, paused: false, now: NOW, busy: false, limitMs: 600_000, notebookUrl: '/n', frozen: true,
  canChoose: true, counted: false, oncancel: () => {}, onchoose: () => {},
}

for (const name of ['SubmissionRow', 'SubmissionCard']) {
  test(`${name}: a late submission is never counted and never offered to count`, () => {
    // Even if a caller marks it counted and leaves the pick open, the row refuses.
    const shown = show(name, { ...rowProps, submission, counted: true, frozen: false })
    assert.doesNotMatch(shown, /в зачёт/)
    assert.doesNotMatch(shown, /Выбрать/)
    assert.match(shown, name === 'SubmissionRow' ? /ПОСЛЕ ДЕДЛАЙНА · ВНЕ ЗАЧЁТА/ : /ПОЗДНЯЯ/)
    // An on-time row with the same props is the counted one, as before.
    assert.match(show(name, { ...rowProps, submission: { ...submission, late: false }, counted: true }), /в зачёт/)
  })
}

test('a late card on a phone keeps its ordinal short beside the LATE chip; an on-time card spells it out', () => {
  // "15-я посылка" next to the chip was cut to "15-я посыл…" at 390 px.
  const late = show('SubmissionCard', { ...rowProps, submission, ordinal: 15 })
  assert.match(late, /15-я #17 ПОЗДНЯЯ/)
  assert.doesNotMatch(late, /15-я посылка/)
  assert.match(show('SubmissionCard', { ...rowProps, submission: { ...submission, late: false }, ordinal: 15 }), /15-я посылка #17/)
})

test('a late scored row says how it compares with the counted one, and a failed late row says "after the deadline"', () => {
  const better = show('SubmissionRow', {
    ...rowProps, submission, lateNote: 'Лучше зачётной #14 на 0.0057, но место и зачёт не меняет.',
  })
  assert.match(better, /Лучше зачётной #14 на 0\.0057, но место и зачёт не меняет\./)
  const failed = show('SubmissionRow', {
    ...rowProps,
    submission: { ...submission, state: 'timedOut', publicScore: null, cellsDone: 9, participantError: 'Превышено 10 минут.' },
    offQuota: true,
  })
  assert.match(failed, /после дедлайна · остановка на ячейке 9 из 15/)
  assert.doesNotMatch(failed, /ВНЕ ЗАЧЁТА/, 'nothing of a failed run counts: no chip to say so')
  assert.match(failed, /10:00 из 10:00 лимит не потрачен/)
})

const blind = {
  ...submission, id: 's18', number: 18, late: false, state: 'notebookFailed', publicScore: null, cellsDone: 6, cellsTotal: 12,
  errorType: 'ValueError', blind: true, notebook: 'sent',
  participantError: 'Тетрадь упала на ячейке 6 из 12: ValueError. Текст ошибки и вывод скрыты — проверка шла на скрытом тесте.',
}

test('a blind failure on a phone shows the cell and the exception class, and that the output is hidden', () => {
  const shown = show('SubmissionCard', { ...rowProps, submission: blind, offQuota: true })
  assert.match(shown, /ячейка 6 из 12 · ValueError/)
  assert.match(shown, /Вывод скрыт: тетрадь исполнялась на скрытом тесте\./)
  assert.match(shown, /лимит не потрачен/)
  // No first line of a traceback where there is none.
  assert.doesNotMatch(shown, /Тетрадь упала на ячейке/)
})

test('a blind failure on a desktop names the class in its caption, under the number the limit stays', () => {
  const shown = show('SubmissionRow', { ...rowProps, submission: blind, offQuota: true })
  assert.match(shown, /ошибка в ячейке 6 из 12 через 3 мин 8 с · ValueError/)
  assert.match(shown, /— лимит не потрачен Подробнее/)
})

test('a blind scored row offers the notebook as it was sent, not one "with output"', () => {
  const shown = show('SubmissionRow', { ...rowProps, submission: { ...submission, late: false, blind: true, notebook: 'sent' } })
  assert.match(shown, /Скачать отправленную тетрадь/)
  assert.doesNotMatch(shown, /с выводом/)
})

const files = [
  { name: 'train.csv', bytes: 21_400_000, rows: 48_600 },
  { name: 'test.csv', bytes: 90_000, rows: 200, sealed: true },
]
const sealedFiles = [{ name: 'test.csv', rows: 2000, replaces: 'test.csv', columns: ['chamber_id', 'store_id', 'window_end'] }]

test('the data list marks the example and promises the hidden test at the same path, with its rows', () => {
  const shown = show('DataFiles', { files, sealedFiles, fileUrl: (name: string) => `/f/${name}` })
  assert.match(shown, /data\/ test\.csv ПРИМЕР 200 строк/)
  assert.match(shown, /при проверке заменяется скрытым тестом \(2 000 строк\) по тому же пути/)
  assert.match(shown, /3 столбца: chamber_id, store_id, window_end/)
  assert.match(shown, /Скрытого теста в списке нет — его не скачать\./)
  // Without a hidden test the list is the list it was.
  const plain = show('DataFiles', { files: [files[0]], fileUrl: (name: string) => `/f/${name}` })
  assert.doesNotMatch(plain, /ПРИМЕР|скрыт/)
})

const competition = {
  slug: 'k', environment: 'base', outputPolicy: 'brief',
  limits: { wallSeconds: 600, memoryMb: 4096, cpus: 2, perDay: 5 },
}
const target = { file: 'data/test.csv', rows: 2000, exampleRows: 200, replaces: true }

test('"How a submission is checked" says the hidden test\'s place and what a failure will show', () => {
  const shown = show('HowChecked', { competition, target })
  assert.match(shown, /Как проверяется посылка/)
  assert.match(shown, /до 10 минут, 4 ГБ памяти\./)
  assert.match(shown, /на месте data\/test\.csv — скрытый тест: те же столбцы, 2 000 строк, другие строки\./)
  assert.match(shown, /номер ячейки и тип ошибки — без вывода и traceback.*Упавшая посылка дневной лимит не тратит\./)
  assert.match(shown, /ОШИБКА В ТЕТРАДИ ячейка 7 из 14 · KeyError лимит не потрачен/)
  assert.match(shown, /Проверьте ячейку 7 на примере data\/test\.csv\./)
  // The full policy promises the output, and draws no blind example.
  const full = show('HowChecked', { competition: { ...competition, outputPolicy: 'full', limits: { ...competition.limits, perDay: 0 } }, target })
  assert.match(full, /вы увидите ошибку и вывод ячеек, как обычно\./)
  assert.doesNotMatch(full, /KeyError|дневной лимит/)
})

test('the conditions column names the hidden test, the output on failure and the limit by score', () => {
  const shown = show('Conditions', { competition, sealedFiles })
  assert.match(shown, /data\/test\.csv скрытый · 2 000 строк/)
  assert.match(shown, /Вывод при ошибке ячейка и тип/)
  assert.match(shown, /Лимит в день 5 с оценкой/)
  assert.match(shown, /кладёт скрытый тест на место data\/test\.csv\. Его строки не попадают ни в вывод/)
  const plain = show('Conditions', { competition: { ...competition, limits: { ...competition.limits, perDay: 0 } } })
  assert.doesNotMatch(plain, /скрытый|Лимит в день/)
  assert.match(plain, /без сохранённых переменных/)
})

test('the mini board says late scores are not on it', () => {
  const shown = show('MiniBoard', { lines: [], lateBest: 0.9261, onopen: () => {} })
  assert.match(shown, /Места считаются только по посылкам до дедлайна\. Ваша лучшая поздняя — 0\.9261 — сюда не входит\./)
  assert.doesNotMatch(show('MiniBoard', { lines: [], onopen: () => {} }), /поздн/)
})

const view = (accepting: string) => ({
  competition: {
    ...competition, title: 'Аварии холодильных камер', state: 'live', deadlineAt: DEADLINE, lateSubmissions: true,
    metric: { name: 'ROC AUC', direction: 'higher' },
  },
  entrants: 31, submissions: 120, accepting, files: [], privateOpen: false, bestPublic: null, baselinePublic: null, mine: null,
})
const header = (accepting: string, phone = false) => show('PageHeader', {
  view: view(accepting), tab: 'submissions', now: NOW, phone, submissions: 18, place: 6, total: 31, finalPlace: null,
  shift: null, score: 0.9204, name: 'Тимур Ахметов', ontab: () => {}, onnavigate: () => {},
})

test('the header after the deadline with late intake: finished, the chip, the passed deadline, no countdown', () => {
  const shown = header('late')
  assert.match(shown, /ЗАВЕРШЕНО приём поздних посылок открыт/)
  assert.match(shown, /ДЕДЛАЙН ПРОШЁЛ сегодня · 12:00/)
  assert.match(shown, /ПУБЛИЧНОЕ МЕСТО 6 из 31/)
  assert.match(shown, /В ЗАЧЁТЕ 0\.9204/)
  assert.match(shown, /Посылки 18/)
  assert.doesNotMatch(shown, /ДО ДЕДЛАЙНА|ИДЁТ/)
  const phone = header('late', true)
  assert.match(phone, /ЗАВЕРШЕНО поздние посылки открыты/)
  assert.doesNotMatch(phone, /ДО ДЕДЛАЙНА/)
  // Closed for good: finished, and no chip promising a door that is shut.
  const closed = header('closed')
  assert.match(closed, /ЗАВЕРШЕНО/)
  assert.doesNotMatch(closed, /поздних/)
})
