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
import { dependencyErrorLines, dependencyErrorText, type DependencyBundle } from '../shared/dependencies.js'
import { dependencyMessage } from '../server/src/dependencies/messages.ts'

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

const MiB = 1024 * 1024
const visible = (bundle: DependencyBundle) => render(Card, { props: { bundle } }).body.replace(/<[^>]*>/g, '')
const oversized: DependencyBundle = {
  ...failed, requirementsText: 'xgboost', normalizedRequirements: ['xgboost'],
  error: { code: 'installed_limit', message: 'Stored at failure time.', params: { bytes: 640 * MiB, limitBytes: 512 * MiB, heaviest: [{ name: 'nvidia-nccl-cu12', bytes: 330 * MiB }, { name: 'xgboost', bytes: 300 * MiB }] } },
  log: [{ code: 'start' }, { code: 'resolve' }, { code: 'download', params: { count: 2 } }, 'docker: raw diagnostic'],
}

test('a size failure shows its numbers, the heaviest packages and a lighter build, in the page language', () => {
  setLocaleResolver(() => 'ru')
  let text = visible(oversized)
  assert.match(text, /Распакованный набор — 640 МБ при лимите 512 МБ\. Больше всего весят: nvidia-nccl-cu12 \(330 МБ\), xgboost \(300 МБ\)\./)
  assert.match(text, /У xgboost есть сборка без CUDA: укажите xgboost-cpu вместо xgboost\./)
  assert.doesNotMatch(text, /Stored at failure time/)
  assert.match(text, /Запускаем подготовку в изолированных контейнерах\.\nСверяем версии пакетов с закреплённой базой\.\nСкачиваем и проверяем 2 дополнительных пакета\.\ndocker: raw diagnostic/)
  setLocaleResolver(() => 'en')
  text = visible(oversized)
  assert.match(text, /Unpacked, the set is 640 MB; the limit is 512 MB\. The heaviest are nvidia-nccl-cu12 \(330 MB\), xgboost \(300 MB\)\./)
  assert.match(text, /xgboost has a build without CUDA: use xgboost-cpu instead of xgboost\./)
  assert.match(text, /Starting preparation in isolated containers\.\nChecking package versions against the pinned base\.\nDownloading and checking 2 extra packages\.\ndocker: raw diagnostic/)
  setLocaleResolver(() => 'ru')
})

test('a pin against the base names the version the base has, after its line label', () => {
  const pinned: DependencyBundle = { ...failed, requirementsText: 'numpy==1.19.5', error: { code: 'base_conflict', line: 1, message: 'Stored.', params: { package: 'numpy', baseVersion: '2.4.6' } } }
  setLocaleResolver(() => 'ru')
  assert.match(visible(pinned), /Строка 1: numpy в базе — 2\.4\.6\. Уберите версию или укажите ==2\.4\.6\./)
  setLocaleResolver(() => 'en')
  assert.match(visible(pinned), /Line 1: The base has numpy 2\.4\.6\. Remove the version or pin ==2\.4\.6\./)
  setLocaleResolver(() => 'ru')
})

test('size texts say how much and which packages, with a hint for torch even when it is not the heaviest', () => {
  const torch = { code: 'download_limit', params: { bytes: 888100000, limitBytes: 500 * MiB, partial: true, heaviest: [{ name: 'torch', bytes: 888100000 }] } }
  const cuda = { code: 'download_limit', params: { bytes: 1100 * MiB, limitBytes: 500 * MiB, heaviest: [{ name: 'nvidia-cudnn-cu12', bytes: 664 * MiB }] } }
  setLocaleResolver(() => 'ru')
  assert.deepEqual(dependencyErrorLines(torch, 'torch'), [
    'Скачать нужно не меньше 847 МБ при лимите 500 МБ. Больше всего весит torch (847 МБ).',
    'Сборка torch без CUDA публикуется не на PyPI, а на download.pytorch.org, поэтому через этот список её не поставить. Попросите преподавателя окружение, где torch уже установлен.',
  ])
  assert.deepEqual(dependencyErrorLines(cuda, '# models\nsentence-transformers\nTorch>=2'), [
    'Скачать нужно 1,1 ГБ при лимите 500 МБ. Больше всего весит nvidia-cudnn-cu12 (664 МБ).',
    tr('dependencies.hint.torch'),
  ])
  assert.equal(dependencyErrorLines(cuda, 'jax[cuda12]').length, 1, 'no hint without a package that has one')
  assert.deepEqual(dependencyErrorLines(torch, 'torch\ntorchvision\nxgboost').slice(1), [tr('dependencies.hint.xgboost'), tr('dependencies.hint.torch')], 'one hint each, torchvision sharing torch')
  // A set a hair over the limit must not read "500 MB with a limit of 500 MB".
  assert.equal(dependencyErrorText({ code: 'download_limit', params: { bytes: 500 * MiB + 5000, limitBytes: 500 * MiB } }), 'Скачать нужно 500,01 МБ при лимите 500 МБ.')
  assert.equal(dependencyErrorText({ code: 'installed_limit', params: { bytes: 600 * MiB, limitBytes: 512 * MiB, partial: true } }), 'Распакованный набор — не меньше 600 МБ при лимите 512 МБ.')
  // Stored before params existed: the code's plain text, still with a hint for a package asked for by name.
  assert.deepEqual(dependencyErrorLines({ code: 'installed_limit', message: 'old' }, 'xgboost==3.2.0'), [tr('dependencies.error.size'), tr('dependencies.hint.xgboost')])
  assert.equal(dependencyMessage('download_limit', torch.params, 'torch'), dependencyErrorLines(torch, 'torch').join(' '))
  setLocaleResolver(() => 'en')
  assert.deepEqual(dependencyErrorLines(torch, 'torch'), [
    'The set is at least 847 MB to download; the limit is 500 MB. The heaviest is torch (847 MB).',
    'The CPU-only build of torch is published on download.pytorch.org, not on PyPI, so this list cannot install it. Ask your teacher for an environment with torch already installed.',
  ])
  assert.equal(dependencyErrorText(cuda), 'The set is 1.1 GB to download; the limit is 500 MB. The heaviest is nvidia-cudnn-cu12 (664 MB).')
  setLocaleResolver(() => 'ru')
})

test('conflict texts name the base version and who requires another, and unknown codes keep their stored text', () => {
  const required = { code: 'dependency_conflict', params: { package: 'numpy', baseVersion: '2.4.6', requiredBy: 'gensim', requiredByVersion: '4.3.2', requirement: 'numpy<2.0,>=1.18.5' } }
  const inside = { code: 'dependency_conflict', params: { package: 'shared', causes: [{ by: null, requirement: 'shared>=3' }, { by: 'alpha 1.0', requirement: 'shared<2' }] } }
  setLocaleResolver(() => 'ru')
  assert.equal(dependencyErrorText(required), 'gensim 4.3.2 требует numpy<2.0,>=1.18.5, а в базе — numpy 2.4.6. Выберите версию gensim, совместимую с базой.')
  assert.equal(dependencyErrorText(inside), 'Пакеты требуют несовместимые версии shared: ваш список — shared>=3; alpha 1.0 — shared<2. Измените версии в списке.')
  assert.equal(dependencyErrorText({ code: 'dependency_conflict' }), 'Версии пакетов конфликтуют с базой или друг с другом. Исправьте версии в списке.')
  assert.equal(dependencyErrorText({ code: 'disk_full' }), 'На сервере недостаточно места для подготовки. Обратитесь к преподавателю.')
  assert.equal(dependencyErrorText({ code: 'resource_limit', message: 'Stored text.' }), 'Stored text.')
  assert.equal(dependencyMessage('constructor'), tr('dependencies.error.generic'), 'a code is looked up as a key, never as an inherited property')
  setLocaleResolver(() => 'en')
  assert.equal(dependencyErrorText(required), 'gensim 4.3.2 requires numpy<2.0,>=1.18.5, but the base has numpy 2.4.6. Choose a version of gensim that works with the base.')
  assert.equal(dependencyErrorText(inside), 'Packages require incompatible versions of shared: your list — shared>=3; alpha 1.0 — shared<2. Change the versions in your list.')
  assert.equal(dependencyErrorText({ code: 'base_conflict', params: { package: 'numpy', baseVersion: '2.4.6' } }), 'The base has numpy 2.4.6. Remove the version or pin ==2.4.6.')
  setLocaleResolver(() => 'ru')
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

for (const phone of [false, true]) {
  test(`the left-today line carries the rule of what spends a submission (${phone ? 'phone' : 'desktop'})`, () => {
    const show = (mine: object) => render(SendBox, { props: {
      view: { competition: { slug: 'sample', limits: { wallSeconds: 600 } } },
      mine: { accepting: 'open', perDay: 5, inFlight: 0, ...mine },
      phone, busy: false, refusal: null, onsend: async () => null, onrefuse: () => {},
    } }).body
    const rule = 'В счёт лимита идёт каждая посылка, чья тетрадь начала выполняться, — даже если упала на первой же ячейке или ответ не принят. Не в счёт: отменённая и та, что не дошла до выполнения (например, не установились пакеты).'
    assert.ok(show({ leftToday: 3 }).includes(
      `${phone ? 'Сегодня осталось 3 посылки из 5.' : 'Сегодня можно отправить ещё 3 посылки из 5.'} ${rule}`,
    ))
    // The day spent is exactly when "why did it come back?" gets asked.
    assert.ok(show({ leftToday: 0 }).includes(`На сегодня посылки кончились: 5 в день на участника. ${rule}`))
    assert.ok(!show({ leftToday: null }).includes(rule), 'no limit, no rule to explain')
    assert.ok(!show({ leftToday: 3, accepting: 'closed' }).includes(rule), 'closed submissions promise nothing')
  })
}
