/**
 * The GPU half of the guides against the code and against the run of
 * 13 October 2026 (a Vast VM with 2 × RTX 4090, driver 580.95.05).
 *
 * The review of GPU submissions found the guides wrong in seven places, each
 * one a decision somebody takes from a sentence:
 *
 *   - the driver. base-gpu pins torch 2.14.1, CUDA 13.0 wheels that kaggle-gpu
 *     inherits, and they need an NVIDIA driver of 580 or newer. Only the Vast
 *     rental scripts knew: on a university server with driver 550 torch
 *     imports, never sees the card, and a guarded notebook trains on the CPU
 *     into its time limit while the competition page promises a share;
 *   - where competition Pods go on Kubernetes. The values table said they
 *     ignore rooms.nodeSelector. They take it, and a GPU submission adds
 *     gpu.nodeSelector on top, so a GPU node without the students' label
 *     never runs one, and the class sees "waiting for resources";
 *   - whose cards nvidia.com/gpu is. GPU rooms request it too, so
 *     submissions given that name take the rooms' cards, and a class's GPU
 *     room is refused while they run — the opposite of the Docker rule;
 *   - "kaggle-gpu adds 1–2 GB": it measured 2.8 GB more, 12.7 GB in all;
 *   - "naming its share and how much it took", which a blind participant
 *     (a hidden test under the default brief output) is never told;
 *   - "otherwise the CPU does the work" about a switch that, with no card
 *     given, refuses uploads instead;
 *   - the Vast README, which still listed as unverified what the 13 October
 *     run checked on real cards.
 *
 * The fixes that followed the review changed what the guides must say once
 * more, and each sentence below is one somebody decides by:
 *
 *   - the watchdog reads the card as root, which the notebook cannot signal,
 *     and it fails closed: a run on a shared card that cannot be read four
 *     times in a row is stopped, not left holding the card unwatched;
 *   - the cap inside covers PyTorch (also after a library that only asked
 *     about it) and CatBoost's GPU pool, and not TensorFlow or JAX, which the
 *     owner of an environment of their own has to know;
 *   - a change of runs per card mid-class leaves every running submission
 *     the share it was taken at;
 *   - a run that its neighbour's burst ran out of memory goes back to the
 *     queue once, instead of being told to shrink a model that fit;
 *   - deleting a competition stops its runs first, and may be refused;
 *   - on Kubernetes: how many GPU submissions go to the cluster at once,
 *     /dev/shm and MPS, the pull allowance of GPU images, and the API's
 *     refusals of GPU Pods, which go back to the queue; and the k3s installer
 *     and the chart's own comments saying the same.
 *
 * Words are checked instead of the deed on purpose, as in
 * docs-readme-drift.test.mts: the deed is in the neighbouring suites
 * (competition-gpu-*, runtime-placement, competition-capabilities, vast-vm),
 * and nobody builds or type-checks a guide. Where the fact has a home in the
 * code — the torch pin, the rooms' resource, the brief message — it is read
 * from there too, so the day it moves this suite says which sentence follows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { competitionsMessages } from '../shared/locales/competitions.js'
import { adminMessages } from '../shared/locales/admin.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')
const LANGS = ['ru', 'en'] as const
type Lang = (typeof LANGS)[number]

/** One section of a guide, from its heading up to the next one. */
function section(lang: Lang, slug: string, id: string): string {
  const body = read(`docs/pages/${lang}/${slug}.html`)
  const at = body.indexOf(`<h2 id="${id}">`)
  assert.notEqual(at, -1, `${lang}/${slug}.html has no section #${id}`)
  const end = body.indexOf('<h2 ', at + 1)
  return body.slice(at, end === -1 ? undefined : end)
}

/** The element of this tag (a paragraph, a table row, a list item) that holds these words. */
function element(html: string, words: string, tag: string): string {
  const at = html.indexOf(words)
  assert.notEqual(at, -1, `no "${words}" in ${html.slice(0, 80)}…`)
  const start = Math.max(html.lastIndexOf(`<${tag}>`, at), html.lastIndexOf(`<${tag} `, at))
  const end = html.indexOf(`</${tag}>`, at)
  assert.ok(start !== -1 && end !== -1, `"${words}" is not inside a <${tag}>`)
  return html.slice(start, end)
}

/** Text as a reader gets it: no tags, entities as characters, one space for any whitespace. */
function plain(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ')
}

/** A Markdown paragraph starting with these words, up to the first blank line, as one line. */
function paragraph(text: string, from: string): string {
  const at = text.indexOf(from)
  assert.notEqual(at, -1, `no paragraph "${from}…"`)
  const end = text.indexOf('\n\n', at)
  return text.slice(at, end === -1 ? undefined : end).replace(/\s+/g, ' ')
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/*
 * ------------------------------------------------------------ the driver
 *
 * What the pin needs is not in any file the code reads: torch 2.14.1 from
 * plain PyPI is the +cu130 build, and CUDA 13.0 wants an NVIDIA driver of 580
 * or newer (NVIDIA's table, checked on the VM: 580.95.05 reports CUDA 13.0).
 * So the three words live here, next to the pin they follow, and a moved pin
 * stops this suite before a guide promises the old floor for a new torch.
 */
const PIN = { torch: '2.14.1', cuda: '13.0', driver: '580' }

test('the guides describe the torch base-gpu pins, and the floor make vast-vm rents by', () => {
  assert.match(
    read('kernel/environments/base-gpu.txt'),
    new RegExp(`^torch==${escape(PIN.torch)}$`, 'm'),
    'base-gpu.txt pins another torch: find the CUDA its wheels are built for and the driver that needs, then update PIN and every guide below',
  )
  assert.match(
    read('scripts/vast-vm.sh'),
    new RegExp(`cuda_max_good"\\) or 0\\) >= ${escape(PIN.cuda)}\\b`),
    'make vast-vm rents by another Max CUDA than the guides name',
  )
})

test('every place that lists what a GPU needs names the driver floor', () => {
  const driver = new RegExp(`\\b${PIN.driver}\\b`)
  const cuda = new RegExp(`CUDA ${escape(PIN.cuda)}`)
  for (const lang of LANGS) {
    const places: Array<[string, string]> = [
      // The sizing list of a university server: "A GPU is optional", with what it needs.
      ['server.html#sizing', plain(element(section(lang, 'server', 'sizing'), 'base-gpu, kaggle-gpu', 'li'))],
      // What a k3s GPU release needs before the installer runs.
      ['install.html#requirements', plain(element(section(lang, 'install', 'requirements'), 'gnupg', 'p'))],
      // The GPU environments themselves.
      ['environments.html#gpu', plain(element(section(lang, 'environments', 'gpu'), 'kaggle-gpu', 'p'))],
      // The platform team's half: the GPU nodes they provide, and the images they build.
      ['kubernetes.html#operations', plain(element(section(lang, 'kubernetes', 'operations'), 'gpu.runtimeClassName', 'p'))],
      ['kubernetes.html#images', plain(element(section(lang, 'kubernetes', 'images'), 'base-gpu', 'p'))],
      // Where a reader goes when CUDA is not there.
      ['troubleshooting.html#gpu', plain(section(lang, 'troubleshooting', 'gpu'))],
    ]
    for (const [where, said] of places) {
      assert.match(said, driver, `${lang}/${where} does not name driver ${PIN.driver}: torch ${PIN.torch} imports on an older one and never sees the card`)
      assert.match(said, cuda, `${lang}/${where} does not say why: the wheels are built for CUDA ${PIN.cuda}`)
    }
    // The torch version itself, in the guide to the environments.
    assert.match(
      plain(element(section(lang, 'environments', 'gpu'), 'kaggle-gpu', 'p')),
      new RegExp(`torch ${escape(PIN.torch)}`),
      `${lang}/environments.html#gpu does not name the torch it pins`,
    )
  }
  const k3s = paragraph(read('deploy/k3s/README.md'), 'GPU hosts must retain a working NVIDIA driver')
  assert.match(k3s, driver, 'the k3s README asks for "a working NVIDIA driver" without its version')
})

/*
 * --------------------------------------------------- Kubernetes placement
 */
test('the values table sends competition Pods where the rooms go, and a GPU submission to both selectors', () => {
  // The deed (runtime/src/competition-jobs.ts · studentPlacement): the job
  // and resolver Pods take the rooms' selector and tolerations, and a GPU
  // notebook adds the GPU nodes' on top.
  const jobs = read('runtime/src/competition-jobs.ts')
  assert.match(jobs, /config\.studentNodeSelector/)
  assert.match(jobs, /config\.gpuNodeSelector/)
  for (const lang of LANGS) {
    const row = plain(element(section(lang, 'kubernetes', 'values'), '<code>rooms.nodeSelector</code>', 'tr'))
    assert.doesNotMatch(row, /don't get them|не получают/, `${lang}/kubernetes.html says competition Pods ignore the rooms' selector`)
    assert.match(row, lang === 'en' ? /competition/ : /соревнован/, `${lang}/kubernetes.html does not say competition Pods take the rooms' selector`)
    assert.match(row, /gpu\.nodeSelector/, `${lang}/kubernetes.html does not say a GPU submission must match gpu.nodeSelector too`)
  }
})

test('the guides warn that nvidia.com/gpu for submissions is the rooms\' own resource', () => {
  // The deed: a GPU room requests one nvidia.com/gpu (runtime/src/controller.ts).
  assert.match(read('runtime/src/controller.ts'), /'nvidia\.com\/gpu': 1/)
  const nodes: Record<Lang, string> = { en: '<strong>GPU nodes.</strong>', ru: '<strong>Узлы с GPU.</strong>' }
  for (const lang of LANGS) {
    const said = plain(element(section(lang, 'kubernetes', 'operations'), nodes[lang], 'p'))
    assert.match(said, lang === 'en' ? /GPU room that finds no card free is refused/ : /GPU-комнат[уа][^.]*не запуска/,
      `${lang}/kubernetes.html does not say a GPU room is refused while submissions hold the cards`)
    // Both ways out, by their names in the device plugin's configuration.
    assert.match(said, /nvidia\.com\/gpu\.shared/)
    assert.match(said, /renameByDefault/)
    assert.match(said, /nvidia\.com\/mig-/)
    const row = plain(element(section(lang, 'kubernetes', 'values'), '<code>gpu.competitions.resource</code>', 'tr'))
    assert.match(row, lang === 'en' ? /GPU rooms request/ : /просят и GPU-комнаты/, `${lang}/kubernetes.html offers nvidia.com/gpu for submissions without a word about rooms`)
    // The competitions guide promises "a class and a submission never share a
    // card" for Docker; its Kubernetes paragraph must take that back.
    const k8s = plain(element(section(lang, 'competitions', 'gpu'), 'gpu.competitions.resource', 'p'))
    assert.match(k8s, lang === 'en' ? /rooms' cards/ : /карт(ами|ы)? комнат/, `${lang}/competitions.html#gpu does not say submissions take the rooms' cards on Kubernetes`)
  }
  // The single-node k3s path: one card, no sharing configured by the installer.
  const k3s = paragraph(read('deploy/k3s/README.md'), 'The notebook step of each such submission')
  assert.match(k3s, /GPU room that finds every card held by submissions is refused/)
  assert.match(k3s, /exclude each other/)
})

/*
 * ------------------------------------------------------------ the sizes
 *
 * `docker images` on the VM, 13 Oct 2026: colloq-kernel:base-gpu 9.88GB, the
 * kaggle-gpu trial (the same pins) 12.7GB. The size includes the parent's
 * layers, so kaggle-gpu adds about 2.8 GB. Disk advice (100 GB) is unchanged.
 */
test('kaggle-gpu is given its measured size, not "1–2 GB more"', () => {
  const files = [
    ...LANGS.flatMap((lang) => ['server', 'environments', 'vast', 'kubernetes'].map((slug) => `docs/pages/${lang}/${slug}.html`)),
    'deploy/vast/README.md', 'deploy/vast/onstart.sh', 'scripts/vast-vm.sh',
  ]
  for (const file of files) {
    const text = read(file)
    assert.doesNotMatch(text, /1\s*[–-]\s*2\s*(GB|ГБ)/, `${file} still says kaggle-gpu adds 1–2 GB; it measured about 2.8 GB more`)
    assert.match(text, /2[.,]8\s*(GB|ГБ)/, `${file} names base-gpu's size but not what kaggle-gpu adds`)
  }
})

/*
 * --------------------------------------------------- what the entrant sees
 */
test('a run stopped for its share is described the way a blind participant reads it', () => {
  // The deed (runner.ts · gpuKillNote): with the full output the participant
  // reads the peak; under the brief output of a hidden test, the share alone.
  const text = (key: string, lang: Lang): string => String(competitionsMessages[key][lang])
  for (const lang of LANGS) {
    assert.match(text('competitions.answer.gpuOutOfMemory', lang), /\{peak\}/)
    assert.doesNotMatch(text('competitions.answer.gpuOverShare', lang), /\{peak\}/)
  }
  const sees: Record<Lang, string> = { en: 'What the entrant sees', ru: 'Что видит участник' }
  for (const lang of LANGS) {
    const said = plain(element(section(lang, 'competitions', 'gpu'), sees[lang], 'p'))
    assert.match(said, lang === 'en' ? /hidden test[^.]*only the share/ : /скрытым тестом[^.]*только доля/,
      `${lang}/competitions.html#gpu promises every participant how much a stopped run took`)
  }
  const readme = paragraph(read('deploy/vast/README.md'), '- outside, the runner reads')
  assert.match(readme, /hidden test[^.]*only the share/, 'the Vast README promises every participant how much a stopped run took')
})

test('the "How a submission is executed" aside does not promise the CPU when the switch is on', () => {
  // The deed (capabilities.ts · evaluateCapabilities): GPU on and no card is
  // gpu_unavailable, and the upload door and the baseline check refuse it.
  const refuses: Record<Lang, RegExp> = { en: /refuses uploads and the baseline check/, ru: /отказывает в загрузке и в проверке бейслайна/ }
  for (const lang of LANGS) {
    const aside = plain(element(section(lang, 'competitions', 'run'), '<aside', 'aside'))
    assert.doesNotMatch(aside, /otherwise the CPU does the work|иначе считает процессор/, `${lang}/competitions.html#run: "otherwise the CPU" covers the switch on with no card`)
    assert.match(aside, refuses[lang], `${lang}/competitions.html#run does not say what the switch does with no card given`)
  }
})

/*
 * ------------------------------------------------- the 13 October record
 */
test('the Vast README lists as unverified only what the 13 October run did not do', () => {
  const readme = read('deploy/vast/README.md')
  const record = readme.slice(readme.indexOf('## What has been verified'), readme.indexOf('## Relation to the other Vast paths'))
  const pending = record.slice(record.indexOf('Not verified yet:'), record.indexOf('\n\n', record.indexOf('Not verified yet:') + 20))
  assert.doesNotMatch(pending, /GPU rooms/, 'a GPU room ran on card 1 next to submissions on card 0')
  assert.doesNotMatch(pending, /GPU submissions end to end/, 'GPU submissions ran end to end, 25 at a time')
  assert.match(pending, /`kaggle-gpu` built by `KERNEL_PRELOAD`/, 'the image on the VM was a hand-built trial: KERNEL_PRELOAD did not build it')
  // What the run did, in the record's own words.
  for (const said of [/5\.50 GiB/, /6141 MB/, /10\.4 GB/, /OutOfMemoryError/, /card 1/, /10 GPU and 4 CPU/]) {
    assert.match(record, said)
  }
})

/*
 * The load table: one measurement, written out three times (the guide in two
 * languages and the Vast README's record). The rows must agree number for
 * number; a re-measure changes all three or this fails.
 */
function htmlTable(lang: Lang): number[][] {
  const head: Record<Lang, string> = { en: 'Cards for submissions', ru: 'Карты для посылок' }
  const table = element(section(lang, 'competitions', 'gpu'), head[lang], 'table')
  return [...table.matchAll(/<tr><td>.*?<\/tr>/g)].map((row) => seconds(plain(row[0].replace(/<\/td>/g, ' | '))))
}

function readmeTable(): number[][] {
  const readme = read('deploy/vast/README.md')
  const at = readme.indexOf('| Cards for submissions |')
  assert.notEqual(at, -1, 'the Vast README has no load table')
  const lines = readme.slice(at).split('\n')
  return lines.slice(2, lines.findIndex((line) => !line.startsWith('|'))).map(seconds)
}

/** The three timings of a row: the cells after the first, as whole seconds. */
function seconds(row: string): number[] {
  return row.split('|').map((cell) => cell.trim()).filter(Boolean).slice(1).map((cell) => {
    const n = /^(\d+) (s|с)$/.exec(cell)
    assert.ok(n, `"${cell}" is not a time in seconds`)
    return Number(n[1])
  })
}

test('the load table says the same in both guides and in the Vast README', () => {
  const en = htmlTable('en')
  assert.equal(en.length, 5, 'CPU only, and four ways to give the cards')
  for (const row of en) assert.equal(row.length, 3, 'the median run, the median verdict, the last verdict')
  assert.deepEqual(htmlTable('ru'), en, 'the Russian table differs from the English one')
  assert.deepEqual(readmeTable(), en, 'the Vast README records other numbers than the guide')
  // The first row is the CPU: the slowest run of them all.
  assert.equal(Math.max(...en.map((row) => row[0])), en[0][0])
})

/*
 * ------------------------------------------- after the review: the code's numbers
 *
 * The constants the sentences below quote, read from where the code keeps
 * them: a guide that says "four times" next to a limit of five is the kind of
 * promise this suite exists to catch.
 */
function constant(source: string, name: string): number {
  const found = new RegExp(`\\bconst ${name} = ([0-9_]+)\\b`).exec(source)
  assert.ok(found, `no constant ${name} where the guides read it from`)
  return Number(found[1].replace(/_/g, ''))
}

/** One line of a Markdown file, starting with these words. */
function line(text: string, from: string): string {
  const at = text.indexOf(from)
  assert.notEqual(at, -1, `no line "${from}…"`)
  const end = text.indexOf('\n', at)
  return text.slice(at, end === -1 ? undefined : end)
}

const SHARE: Record<Lang, string> = { en: '<strong>The share.</strong>', ru: '<strong>Доля карты.</strong>' }
const HELD: Record<Lang, string> = { en: '<strong>How the share is held.</strong>', ru: '<strong>Как держат долю.</strong>' }
const SEES: Record<Lang, string> = { en: '<strong>What the entrant sees.</strong>', ru: '<strong>Что видит участник.</strong>' }
const NODES: Record<Lang, string> = { en: '<strong>GPU nodes.</strong>', ru: '<strong>Узлы с GPU.</strong>' }
const shareParagraph = (lang: Lang): string => plain(element(section(lang, 'competitions', 'gpu'), SHARE[lang], 'p'))
const heldParagraph = (lang: Lang): string => plain(element(section(lang, 'competitions', 'gpu'), HELD[lang], 'p'))
const seesParagraph = (lang: Lang): string => plain(element(section(lang, 'competitions', 'gpu'), SEES[lang], 'p'))
const nodesParagraph = (lang: Lang): string => plain(element(section(lang, 'kubernetes', 'operations'), NODES[lang], 'p'))
const vastReadme = (): string => read('deploy/vast/README.md')

test('the guides describe the watchdog the runner has: as root, two readings over the line, closed when the card cannot be read', () => {
  // The deed (docker-runner.ts · VramWatch, watch): the sample is a root exec
  // on the status cycle, and VRAM_UNREAD_LIMIT failures in a row stop the run.
  const runner = read('server/src/competitions/docker-runner.ts')
  // The numbers live in gpu-math.ts, which gpu.ts re-exports (a machine for submissions imports them without the pool).
  const gpu = read('server/src/competitions/gpu-math.ts')
  assert.match(runner, /\['exec', '--user', '0:0', this\.container, 'nvidia-smi'/, 'the watchdog no longer samples as root: the guides say the notebook cannot signal it')
  assert.match(runner, /vram\?\.unwatchable\(\)\) \{\s*await docker\(\['kill'/, 'a run whose card cannot be read is no longer stopped: the guides say it is')
  const cycle = constant(runner, 'STATUS_EVERY_MS') / 1000
  const unread = constant(runner, 'VRAM_UNREAD_LIMIT')
  const tolerance = constant(gpu, 'GPU_TOLERANCE_MB')
  const context = constant(gpu, 'GPU_CONTEXT_MB')
  for (const lang of LANGS) {
    const said = heldParagraph(lang)
    const words = lang === 'en'
      ? [new RegExp(`every ${cycle} seconds`), new RegExp(`more than ${tolerance} MB over its share twice in a row`),
          new RegExp(`${context} MB for the CUDA context`), /as root/,
          new RegExp(`cannot be read ${unread} times in a row \\(about ${unread * cycle} seconds\\) is stopped too`)]
      : [new RegExp(`каждые ${cycle} секунд`), new RegExp(`дважды подряд превысила долю больше чем на ${tolerance} МБ`),
          new RegExp(`${context} МБ на контекст CUDA`), /от root/,
          new RegExp(`${unread} раз[а]? подряд не удалось прочитать \\(около ${unread * cycle} секунд\\), тоже останавливают`)]
    for (const word of words) assert.match(said, word, `${lang}/competitions.html#gpu does not say ${word} about the watchdog`)
    // A whole card has neither half (docker-runner.ts · heldShareMb).
    assert.match(said, lang === 'en' ? /nothing is capped or watched/ : /ничего не ограничивается и не проверяется/)
  }
  const outside = line(vastReadme(), '- outside, the runner reads')
  for (const word of [/--user 0:0/, new RegExp(`every ${cycle} seconds`), new RegExp(`more than ${tolerance} MB over its share`),
    new RegExp(`${unread} failed in a row \\(about ${unread * cycle} seconds\\)`)]) {
    assert.match(outside, word, `the Vast README does not say ${word} about the watchdog`)
  }
})

test('the guides say what the cap inside holds: PyTorch and CatBoost\'s pool, not TensorFlow or JAX', () => {
  // The deed (harness.ts · SITECUSTOMIZE, docker-runner.ts · runArgs): the
  // hooks the file installs, the participant's own part kept, and the two
  // variables the runner passes for a share.
  const harness = read('server/src/competitions/harness.ts')
  const runner = read('server/src/competitions/docker-runner.ts')
  assert.match(harness, /_HOOKS\["torch"\] = _cap_torch/)
  assert.match(harness, /_HOOKS\["catboost"\] = _default_catboost/)
  assert.match(harness, /params\.get\("gpu_ram_part"\) is None/, 'CatBoost\'s own gpu_ram_part is no longer kept: the guides say it is')
  assert.doesNotMatch(harness, /_HOOKS\["(tensorflow|jax)"\]/, 'sitecustomize now caps TensorFlow or JAX: the guides say nothing does')
  assert.match(runner, /`COLLOQ_GPU_MEMORY_MB=\$\{/)
  assert.match(runner, /`COLLOQ_GPU_CARD_MB=\$\{/)
  for (const lang of LANGS) {
    const said = heldParagraph(lang)
    // The probe that took the cap away before (polars asks about torch at its own import).
    assert.match(said, /polars/, `${lang}/competitions.html#gpu does not say the cap holds after a library asked about PyTorch first`)
    assert.match(said, /CatBoost[^.]*95 %/)
    assert.match(said, /gpu_ram_part/)
    assert.match(said, lang === 'en' ? /unless the notebook sets its own/ : /если тетрадь не задала свою/)
    assert.match(said, /XGBoost/)
    assert.match(said, lang === 'en' ? /TensorFlow and JAX[^.]*are not capped/ : /TensorFlow и JAX[^.]*не ограничиваются/,
      `${lang}/competitions.html#gpu does not warn that TensorFlow and JAX are not capped`)
  }
  const inside = line(vastReadme(), '- inside, ')
  for (const word of [/COLLOQ_GPU_MEMORY_MB/, /COLLOQ_GPU_CARD_MB/, /gpu_ram_part/, /polars/, /TensorFlow and JAX/]) {
    assert.match(inside, word, `the Vast README's inside half does not name ${word}`)
  }
})

test('a change of runs per card mid-class is described as the queue does it: each run keeps its share', () => {
  // The deed: the take pins the runs per card on the queue row (store.ts),
  // the run's share is cut from that pin (runner.ts · runGpu), and a card is
  // full when a new share no longer fits beside the old ones (gpu-math.ts · cardsInUse, re-exported by gpu.ts).
  assert.match(read('server/src/competitions/store.ts'), /gpu_per_device/)
  assert.match(read('server/src/competitions/runner.ts'), /const perDevice = row\.gpuPerDevice \?\? runnerGpuPerDevice\(\)/)
  assert.match(read('server/src/competitions/gpu-math.ts'), /export function cardsInUse\(/)
  for (const lang of LANGS) {
    assert.match(shareParagraph(lang), lang === 'en' ? /keeps the share it started with/ : /сохраняет долю, с которой началась/,
      `${lang}/competitions.html#gpu does not say what a change of runs per card does to the running ones`)
    const row = plain(element(section(lang, 'server', 'settings'), '<code>COMPETITION_GPU_PER_DEVICE</code>', 'tr'))
    assert.match(row, lang === 'en' ? /keeps its share/ : /сохраняет свою долю/, `${lang}/server.html#settings does not say a running submission keeps its share`)
  }
  assert.match(paragraph(vastReadme(), 'The second setting is how many submissions share one card'), /keeps the share it started with/)
})

test('a card given back to the rooms is described as the pool does it: a class gets it once the submissions on it end', () => {
  // The deed (kernel/pool.ts · submissionGpuCards): a new room is kept off
  // every card a submission holds, by its container's label or by the queue's
  // binding of a run whose container is not up yet.
  const pool = read('server/src/kernel/pool.ts')
  assert.match(pool, /return \[\.\.\.new Set\(\[\.\.\.containers, \.\.\.queueBoundCards\(\)\]\)\]/)
  const owner: Record<Lang, string> = { en: '<strong>The owner gives cards.</strong>', ru: '<strong>Владелец отдаёт карты.</strong>' }
  for (const lang of LANGS) {
    const said = plain(element(section(lang, 'competitions', 'gpu'), owner[lang], 'li'))
    assert.match(said, lang === 'en'
      ? /a card given back to the rooms serves a class once the submissions running on it end/
      : /карта, возвращённая комнатам, начинает служить занятию, когда закончатся идущие на ней посылки/,
    `${lang}/competitions.html#gpu does not say what happens to a card given back while a submission runs on it`)
  }
  assert.match(vastReadme(), /a card given back to the rooms serves a class once the submissions running on it end/)
})

test('the guides say what an entrant reads when a card cannot be read, and that a neighbour\'s burst is retried once', () => {
  // The deed: a card that answered and went silent is the notebook's failure,
  // one that never answered is ours (docker-runner.ts · verdictOfRun); and a
  // torch out-of-memory beside a neighbour stopped for its share goes back to
  // the queue once (runner.ts), with words that say the attempt does not count.
  assert.match(read('server/src/competitions/docker-runner.ts'), /if \(input\.killedBy === 'gpu-unread'\) return input\.cardRead \? 'cell_error' : 'harness_error'/)
  assert.match(read('server/src/competitions/runner.ts'), /errorType === 'OutOfMemoryError' && row\.resourceRetries === 0/)
  for (const lang of LANGS) {
    assert.match(String(competitionsMessages['competitions.answer.gpuNeighbourRetry'][lang]), lang === 'en' ? /does not count/ : /не засчитывается/)
    const said = seesParagraph(lang)
    const words = lang === 'en'
      ? [/card stopped answering is stopped as Notebook failed/, /nvidia-smi/, /goes back to the queue once/, /that attempt does not count/]
      : [/карта которой перестала отвечать, останавливается как «Упала тетрадь»/, /nvidia-smi/, /один раз возвращают в очередь/, /эта попытка не засчитывается/]
    for (const word of words) assert.match(said, word, `${lang}/competitions.html#gpu does not say ${word}`)
  }
  assert.match(line(vastReadme(), '- a burst outside the cap'), /back to the queue once/)
})

test('deleting a competition is described as the route does it: its runs are stopped first', () => {
  // The deed (admin-competitions.ts, runner.ts · stopCompetitionRuns): the
  // waiting ones leave the queue, the running ones are killed and waited for,
  // and a run still going refuses the delete.
  assert.match(read('server/src/routes/admin-competitions.ts'), /stopCompetitionRuns\(competition\.id, SETTLE_MS\)/)
  const settle = constant(read('server/src/competitions/erase.ts'), 'SETTLE_MS') / 1000
  // The waiting ones are cancelled before anything waits, and stay so when a run refuses the delete.
  assert.match(read('server/src/competitions/runner.ts'), /leaveQueue\(row\.submissionId\)\s*updateSubmission\(row\.submissionId, \{ state: 'cancelled'/)
  for (const lang of LANGS) {
    // The menu item by the words the panel shows.
    const label = String(adminMessages['admin.competitions.menu.delete'][lang])
    const said = plain(element(section(lang, 'competitions', 'queue'), label, 'p'))
    assert.match(said, new RegExp(`up to ${settle} seconds|до ${settle} секунд`), `${lang}/competitions.html#queue does not say how long a delete waits for a run`)
    assert.match(said, lang === 'en' ? /nothing is deleted/ : /ничего не удаляется/, `${lang}/competitions.html#queue does not say a run that does not stop refuses the delete`)
    assert.match(said, lang === 'en' ? /waiting ones stay cancelled/ : /ждавшие посылки остаются отменёнными/, `${lang}/competitions.html#queue does not say the waiting submissions stay cancelled`)
  }
})

/*
 * ------------------------------------------------- Kubernetes, after the review
 */
test('the Kubernetes guide lists the GPU queue, /dev/shm and pull values with the chart\'s defaults', () => {
  const values = read('deploy/helm/colloq/values.yaml')
  const block = values.slice(values.indexOf('\n  competitions:\n'), values.indexOf('\npersistence:'))
  const value = (key: string): string => {
    const found = new RegExp(`^    ${key}: (\\S+)$`, 'm').exec(block)
    assert.ok(found, `values.yaml has no gpu.competitions.${key}`)
    return found[1]
  }
  const shm = value('shmMb')
  const pull = value('pullSeconds')
  assert.equal(value('slots'), 'null', 'gpu.competitions.slots has a default now: the guide says "one at a time"')
  // The broker's own defaults are the chart's (runtime/src/config.ts).
  const config = read('runtime/src/config.ts')
  assert.match(config, /whole\('RUNTIME_COMPETITION_GPU_SLOTS', 1, COMPETITION_GPU_SLOTS_MAX, null\)/)
  assert.match(config, new RegExp(`whole\\('RUNTIME_COMPETITION_GPU_SHM_MB', 0, 65536, ${shm}\\)`))
  assert.match(config, new RegExp(`whole\\('RUNTIME_COMPETITION_GPU_PULL_SECONDS', 0, COMPETITION_GPU_PULL_SECONDS_MAX, ${pull}\\)`))
  // Neither half of the share runs under the cluster: no cap is passed and no
  // watchdog exists there (runner-port.ts · CLUSTER_GPU has no share).
  assert.match(read('server/src/competitions/runner-port.ts'), /CLUSTER_GPU[^=]*= Object\.freeze\(\{ device: '', sliceMb: null, perDevice: 1 \}\)/)
  for (const lang of LANGS) {
    const limit = plain(element(section(lang, 'kubernetes', 'limits'), lang === 'en' ? "A GPU submission's share is the device plugin's." : 'Доля карты у GPU-посылки', 'li'))
    assert.match(limit, lang === 'en' ? /neither caps nor watches video memory/ : /не ограничивает и не проверяет/,
      `${lang}/kubernetes.html#limits does not say there is no watchdog on Kubernetes`)
  }
  // 0 is a setting of its own: no /dev/shm of ours (competition-jobs.ts · shmMb).
  assert.match(read('runtime/src/competition-jobs.ts'), /this\.shmMb\(intent\) \? \[mount\('shm', '\/dev\/shm'\)\] : \[\]/)
  for (const lang of LANGS) {
    const rows: Array<[string, string, RegExp]> = [
      ['gpu.competitions.slots', 'RUNTIME_COMPETITION_GPU_SLOTS', lang === 'en' ? /one at a time/ : /по одной/],
      ['gpu.competitions.shmMb', 'RUNTIME_COMPETITION_GPU_SHM_MB', new RegExp(`^${shm}$`)],
      ['gpu.competitions.pullSeconds', 'RUNTIME_COMPETITION_GPU_PULL_SECONDS', new RegExp(`^${pull}$`)],
    ]
    for (const [key, variable, unset] of rows) {
      const row = element(section(lang, 'kubernetes', 'values'), `<code>${key}</code>`, 'tr')
      const cells = [...row.matchAll(/<td>(.*?)<\/td>/g)].map((cell) => plain(cell[1]).trim())
      assert.match(cells[1] ?? '', new RegExp(variable), `${lang}/kubernetes.html: the ${key} row does not name ${variable}`)
      assert.match(cells[cells.length - 1] ?? '', unset, `${lang}/kubernetes.html: the ${key} row gives another default than the chart`)
    }
    const nodes = nodesParagraph(lang)
    assert.match(nodes, /MPS[^.]*gpu\.competitions\.shmMb: 0/, `${lang}/kubernetes.html does not tell an MPS cluster to set gpu.competitions.shmMb: 0`)
    // The writable volumes of the security list, a GPU submission's /dev/shm among them.
    assert.match(plain(element(section(lang, 'kubernetes', 'security'), '<strong>Pod Security.</strong>', 'p')), /gpu\.competitions\.shmMb/,
      `${lang}/kubernetes.html#security lists no /dev/shm for a GPU submission`)
    const images = plain(element(section(lang, 'kubernetes', 'images'), 'base-gpu', 'p'))
    assert.match(images, new RegExp(`gpu\\.competitions\\.pullSeconds[^.]*${pull}`), `${lang}/kubernetes.html#images does not name the pull allowance of GPU images`)
  }
})

test('the Kubernetes guide says how many GPU submissions go to the cluster, and that a refused one goes back to the queue', () => {
  // The deed: the queue keeps the broker's number of GPU notebooks (runner.ts
  // · queueCards), and a GPU notebook's Pod refused at admission is
  // "unschedulable, gpu", the status the app defers (competition-jobs.ts ·
  // refusedAtAdmission).
  assert.match(read('server/src/competitions/runner.ts'), /\{ cards: \[\], cluster: clusterSlots \}/)
  assert.match(read('runtime/src/competition-jobs.ts'), /failure: \{ code: 'unschedulable', resource: 'gpu' \}/)
  for (const lang of LANGS) {
    const nodes = nodesParagraph(lang)
    const words = lang === 'en'
      ? [/gpu\.competitions\.slots[^.]*one while it is unset/, /CPU submissions go past the rest/, /ResourceQuota/, /RuntimeClass the cluster lacks/, /goes back to the queue/]
      : [/gpu\.competitions\.slots[^.]*по одной, пока оно не задано/, /процессорные посылки проходят мимо остальных/, /ResourceQuota/, /в кластере нет нужного RuntimeClass/, /возвращается в очередь/]
    for (const word of words) assert.match(nodes, word, `${lang}/kubernetes.html (GPU nodes) does not say ${word}`)
    const quota = plain(element(section(lang, 'kubernetes', 'sizing'), lang === 'en' ? 'Pod over the quota' : 'Под сверх квоты', 'li'))
    assert.match(quota, /requests\.nvidia\.com\/gpu/, `${lang}/kubernetes.html#sizing does not name the GPU key of a quota`)
    assert.match(quota, /gpu\.competitions\.slots/)
    assert.match(plain(element(section(lang, 'competitions', 'gpu'), 'gpu.competitions.resource', 'p')), /gpu\.competitions\.slots/,
      `${lang}/competitions.html#gpu does not say how many GPU submissions go to the cluster at once`)
  }
})

test('the k3s README names every competition GPU setting the installer renders into the broker', () => {
  // The deed (scripts/release.py · GPU_SETTINGS): what the installer checks,
  // renders into the broker Deployment and keeps on every update.
  const settings = /GPU_SETTINGS = \(([^)]*)\)/.exec(read('scripts/release.py'))
  assert.ok(settings, 'scripts/release.py has no GPU_SETTINGS')
  const names = [...settings[1].matchAll(/'([A-Z_]+)'/g)].map((name) => name[1])
  assert.ok(names.length >= 2)
  const k3s = read('deploy/k3s/README.md')
  const gpu = k3s.slice(k3s.indexOf('## Competition GPU'), k3s.indexOf('\n## ', k3s.indexOf('## Competition GPU') + 1))
  for (const name of names) assert.match(gpu, new RegExp(`\\b${name}\\b`), `the k3s README does not name ${name}, which the installer renders into the broker`)
  assert.doesNotMatch(gpu, /check both/, `the installer checks all ${names.length} settings, not two`)
})

test('values.yaml says where competition Pods run, as the guide does', () => {
  const values = read('deploy/helm/colloq/values.yaml')
  const at = values.indexOf('# RUNTIME_ROOM_NODE_SELECTOR / RUNTIME_ROOM_TOLERATIONS')
  assert.notEqual(at, -1)
  const comment = values.slice(at, values.indexOf('  nodeSelector: {}', at)).replace(/\s*#\s*/g, ' ')
  assert.match(comment, /competition/, 'values.yaml says only rooms and personal notebooks take rooms.nodeSelector')
  assert.match(comment, /gpu\.nodeSelector/, 'values.yaml does not say a GPU submission must match gpu.nodeSelector too')
})

test('the server guide says the cards are read when the server starts', () => {
  // The deed: index.ts starts the inventory's watch (kernel/resources.ts · watchGpuCards).
  assert.match(read('server/src/index.ts'), /^\s*watchGpuCards\(\)/m)
  for (const lang of LANGS) {
    const said = plain(element(section(lang, 'server', 'sizing'), lang === 'en' ? 'GPUs for submissions' : 'Видеокарты для посылок', 'p'))
    assert.match(said, lang === 'en' ? /when the server starts/ : /при запуске сервера/, `${lang}/server.html#sizing does not say when the cards are read`)
  }
})
