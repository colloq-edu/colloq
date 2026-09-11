/**
 * Какой Python у окружения — от строки в файле до строки в панели.
 *
 * Версия приходит из БАЗОВОГО ОБРАЗА: `python:3.12-slim-bookworm` — это и есть
 * интерпретатор, а всё остальное встаёт слоями поверх него. Отсюда три вещи,
 * которые здесь и закреплены. Версию просит корень цепочки, а не лист: слой
 * поверх готового образа ставит колёса под тот Python, что пришёл из базы, и
 * заменить его не может. Умолчание живёт в kernel/Dockerfile, а не вторым
 * числом рядом. И собранный образ рассказывает о себе сам — переменной
 * PYTHON_VERSION, — потому что файл могли поправить после сборки, и тогда
 * панель обязана показать обе версии, а не выбрать удобную.
 *
 * Соседний environments.test.mts держит остальную семью директив (`gpu`,
 * `from`), и разбор у них общий — shared/admin.ts.
 */
import './_env.mts'
import http from 'node:http'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import type { Response } from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChain,
  buildCommand,
  declaresPython,
  listChanged,
  parseImageFacts,
  parsePackages,
  pythonOf,
  rootParentImage,
} from '../server/src/environments.js'
import { adminEnvironmentRoutes } from '../server/src/routes/admin-environments.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import {
  DEFAULT_PYTHON,
  PYTHON_VERSIONS,
  STAFF_COOKIE,
  pythonImage,
  unreadablePython,
  withPython,
} from '../shared/admin.js'
import { parseRuntimeCatalog } from '../shared/runtime.js'
import { translate } from '../shared/i18n.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

/* ------------------------------------------------------------- директива */

test('директива в шапке называет версию, а pip её не видит', () => {
  const source = '# зрение\n# colloq: python 3.12\ntorch>=2.4\n'
  assert.equal(declaresPython(source), '3.12')
  // Для pip это комментарий: ни лишнего пакета в счёте, ни «Needs rebuild» на
  // собранном образе из-за одной строки.
  assert.deepEqual(parsePackages(source), ['torch>=2.4'])
  assert.equal(listChanged('torch>=2.4\n', source), false)
})

test('пробелы и регистр директиву не ломают, а фраза о ней — не директива', () => {
  assert.equal(declaresPython('  #   colloq:  python   3.12  \n'), '3.12')
  assert.equal(declaresPython('# Colloq: PYTHON 3.13\n'), '3.13')
  assert.equal(declaresPython('# colloq: python 3.12 и новее\n'), null)
  assert.equal(declaresPython('# ставится на python 3.12\n'), null)
})

test('версией считается только то, под что есть официальный slim-образ', () => {
  for (const ok of ['3.9', '3.10', '3.11', '3.12', '3.13']) {
    assert.equal(declaresPython(`# colloq: python ${ok}\n`), ok, ok)
  }
  // `python:3.8-slim-bookworm` не существует, «3.12.7» и «3` тегами тоже не
  // являются: собрать это нельзя, и молча собрать вместо него что-то другое —
  // худший из ответов. Не версия — не директива, и окружение поедет на
  // умолчании, о чём редактор говорит отдельной строкой.
  for (const bad of ['3.8', '2.7', '4.0', '3.14', '3.12.7', '3', 'latest', '']) {
    assert.equal(declaresPython(`# colloq: python ${bad}\n`), null, bad)
  }
})

test('похожая на директиву строка названа вслух, а не проглочена', () => {
  assert.equal(unreadablePython('# colloq: python 3.8\n'), '# colloq: python 3.8')
  assert.equal(unreadablePython('# colloq: python 3.12\n'), null)
  assert.equal(unreadablePython('# зрение\ntorch>=2.4\n'), null)
})

test('директива пишется в шапку, а умолчание не пишется вовсе', () => {
  const source = '# зрение\ntorch>=2.4\n'
  assert.equal(withPython(source, '3.12'), '# colloq: python 3.12\n# зрение\ntorch>=2.4\n')
  // Файл без строки и файл со строкой про умолчание значат одно и то же, а
  // второй ещё и соврёт, если умолчание в Dockerfile однажды поднимут.
  assert.equal(withPython(withPython(source, '3.12'), DEFAULT_PYTHON), source)
  // Двух строк про версию в одной шапке не бывает: читалась бы первая, а
  // правил бы человек вторую.
  const twice = withPython(withPython(source, '3.12'), '3.13')
  assert.equal(declaresPython(twice), '3.13')
  assert.equal(twice.split('\n').filter((line) => /colloq:\s*python/.test(line)).length, 1)
  // И то, что ввели кнопкой, читается обратно тем же разбором, что и сборкой.
  for (const version of PYTHON_VERSIONS) {
    assert.equal(declaresPython(withPython(source, version)) ?? DEFAULT_PYTHON, version)
  }
})

/* ------------------------------------------------- версию задаёт корень */

/** Окружения, каких на диске нет: разбор цепочки от диска не зависит. */
function reader(files: Record<string, string>) {
  return (name: string): string | null => files[name] ?? null
}

const CHAIN = {
  'base-gpu': '# colloq: gpu\n# colloq: python 3.12\ntorch>=2.4\n',
  gpu: '# colloq: from base-gpu\ntransformers>=4.44\n',
  vlm: '# colloq: from gpu\nqwen-vl\n',
  plain: 'pillow\n',
}

test('версия наследуется вместе с базовым образом', () => {
  const files = reader(CHAIN)
  assert.equal(pythonOf('base-gpu', files), '3.12')
  assert.equal(pythonOf('gpu', files), '3.12')
  assert.equal(pythonOf('vlm', files), '3.12')
  // Ничего не сказано — умолчание Dockerfile, то есть ровно прежняя сборка.
  assert.equal(pythonOf('plain', files), DEFAULT_PYTHON)
  assert.equal(pythonOf('нет-такого', files), DEFAULT_PYTHON)
})

test('своя версия у ребёнка — отказ, и обе версии названы вслух', () => {
  const files = reader({ ...CHAIN, gpu: '# colloq: from base-gpu\n# colloq: python 3.10\n' })
  // Слой поверх готового образа интерпретатор не меняет: сборка собрала бы это
  // на 3.12 и молча, а панель показывала бы 3.10.
  assert.throws(() => buildChain('gpu', files), /gpu/)
  assert.throws(() => buildChain('gpu', files), /3\.10/)
  assert.throws(() => buildChain('gpu', files), /base-gpu/)
  assert.throws(() => buildChain('gpu', files), /3\.12/)
  // И у внука тоже: цепочка проверяется целиком, а не на один шаг вверх.
  assert.throws(
    () => buildChain('vlm', reader({ ...CHAIN, vlm: '# colloq: from gpu\n# colloq: python 3.11\n' })),
    /3\.11/,
  )
})

test('повтор родительской версии — не конфликт, а лишняя строка', () => {
  const same = reader({ ...CHAIN, gpu: '# colloq: from base-gpu\n# colloq: python 3.12\n' })
  assert.deepEqual(buildChain('gpu', same), ['base-gpu', 'gpu'])
  assert.equal(pythonOf('gpu', same), '3.12')
  // Корню своя версия не запрещена ничем: он её и задаёт.
  assert.deepEqual(buildChain('base-gpu', reader(CHAIN)), ['base-gpu'])
})

test('сломанная цепочка оставляет панели то, что просит сам файл', () => {
  // Об этом скажет сборка; здесь нужно что-то показать, и выдумывать нечего.
  const broken = reader({ lone: '# colloq: from нет-такого\n# colloq: python 3.13\n' })
  assert.throws(() => buildChain('lone', broken))
  assert.equal(pythonOf('lone', broken), '3.13')
})

test('образцовые окружения репозитория едут на умолчании', () => {
  // Выпадет умолчание из Dockerfile — и это заметит следующий тест, а не пара.
  for (const name of ['base', 'cv', 'gpu', 'base-gpu']) {
    assert.equal(pythonOf(name), DEFAULT_PYTHON, name)
  }
})

/* ------------------------------------------------- умолчание в одном месте */

test('умолчание версии совпадает с тем, что действует в Dockerfile и compose', () => {
  /*
   * Второе число, живущее рядом с первым, — это ровно тот способ соврать
   * молча: панель показывала бы 3.11 над образом, собранным на 3.12. Поэтому
   * DEFAULT_PYTHON проверяется об оба места, где база называется по имени.
   */
  const arg = /^ARG PARENT=(python:([0-9]+\.[0-9]+)-slim-bookworm)$/m.exec(read('kernel/Dockerfile'))
  assert.ok(arg, 'в kernel/Dockerfile больше нет строки ARG PARENT=python:<версия>-slim-bookworm')
  assert.equal(arg[2], DEFAULT_PYTHON)
  assert.equal(arg[1], pythonImage(DEFAULT_PYTHON))
  // compose подставляет то же самое, когда KERNEL_PARENT не задан.
  assert.match(
    read('docker-compose.yml'),
    new RegExp(`PARENT: \\$\\{KERNEL_PARENT:-${pythonImage(DEFAULT_PYTHON)}\\}`),
  )
  // И Makefile берёт умолчание оттуда же, а не третьим числом.
  assert.match(read('Makefile'), /PY_DEFAULT := \$\(shell sed -nE 's\/\^ARG PARENT=python:/)
})

/* ------------------------------------------------------ чем это собирается */

/** Путь к каталогу kernel в этих проверках: сам он существовать не обязан. */
const KERNEL = '/srv/colloq/kernel'

test('корень цепочки собирается на официальном образе своей версии', () => {
  assert.equal(rootParentImage('3.12'), 'python:3.12-slim-bookworm')
  const direct = buildCommand({ via: 'direct' }, 'cv', rootParentImage('3.12'), KERNEL).args.join(' ')
  assert.ok(direct.includes('--build-arg PARENT=python:3.12-slim-bookworm'))
  assert.ok(direct.includes('-t colloq-kernel:cv'))
  // Тот же образ и тем же именем через compose: расходиться этим двум путям
  // нельзя — из них выходит один и тот же `colloq-kernel:<имя>`.
  const { env } = buildCommand({ via: 'compose', files: [] }, 'cv', rootParentImage('3.12'))
  assert.equal(env.KERNEL_PARENT, 'python:3.12-slim-bookworm')
  assert.equal(env.KERNEL_ENV, 'cv')
})

test('ребёнку версия не передаётся: он встаёт на образ родителя', () => {
  const direct = buildCommand({ via: 'direct' }, 'gpu', 'colloq-kernel:base-gpu', KERNEL).args.join(' ')
  assert.ok(direct.includes('--build-arg PARENT=colloq-kernel:base-gpu'))
  assert.ok(!direct.includes('python:'))
  const { env } = buildCommand({ via: 'compose', files: [] }, 'gpu', 'colloq-kernel:base-gpu')
  assert.equal(env.KERNEL_PARENT, 'colloq-kernel:base-gpu')
})

test('KERNEL_PARENT оператора сильнее директивы — и об этом говорят вслух', () => {
  // Это способ собрать цепочку на своём базовом образе; игнорировать его молча
  // значит собрать не то, что просили.
  assert.equal(rootParentImage('3.12', 'ghcr.io/uni/base:2026'), 'ghcr.io/uni/base:2026')
  assert.equal(rootParentImage('3.12', '  '), 'python:3.12-slim-bookworm')
  assert.equal(rootParentImage('3.12', undefined), 'python:3.12-slim-bookworm')
  // Строка журнала называет обе стороны: в панели у окружения будет стоять
  // версия из директивы, а в образе — чужая.
  const said = translate('ru', 'server.kernelParentIsSetInTheServers.4c1d90', {
    p0: 'ghcr.io/uni/base:2026',
    p1: 'python:3.12-slim-bookworm',
  })
  assert.match(said, /KERNEL_PARENT=ghcr\.io\/uni\/base:2026/)
  assert.match(said, /python:3\.12-slim-bookworm/)
})

/* --------------------------------------------- что рассказывает сам образ */

/**
 * Один `docker image inspect` на окружение: размер, дата и переменные образа.
 * Список опрашивает каждое окружение на каждое открытие экрана, и второй вызов
 * на строку удвоил бы это в том же цикле событий, который ведёт чужую пару.
 */
const INSPECT = [
  '1234567890',
  '2026-09-12T08:30:00.123456789Z',
  'PATH=/usr/local/bin:/usr/local/sbin',
  'LANG=C.UTF-8',
  'GPG_KEY=7169605F62C751356D054A26A821E680E5FA6305',
  'PYTHON_VERSION=3.12.7',
  'PYTHON_SHA256=24887b92e2afd4a2ac602419ad4b596372f67ac9b077190f',
  'PYTHONUNBUFFERED=1',
  '',
].join('\n')

test('версия собранного образа читается из его же конфигурации', () => {
  const facts = parseImageFacts(INSPECT)
  assert.ok(facts)
  assert.equal(facts.bytes, 1_234_567_890)
  assert.equal(facts.builtAt, Date.parse('2026-09-12T08:30:00.123456789Z'))
  // Патч сохраняется целиком: `3.12.7` — то, что в образе правда стоит, и
  // показать это честнее, чем округлить до минорной.
  assert.equal(facts.python, '3.12.7')
  // PYTHON_SHA256 рядом стоит нарочно: разбор по началу строки, а не по
  // вхождению слова.
})

test('образ, который про Python молчит, остаётся образом', () => {
  const quiet = parseImageFacts('42\n2026-09-12T08:30:00Z\nPATH=/usr/bin\n')
  assert.deepEqual(quiet, { bytes: 42, builtAt: Date.parse('2026-09-12T08:30:00Z'), python: null })
  // Не собран вовсе — это null целиком, а не запись с нулями.
  assert.equal(parseImageFacts(''), null)
  assert.equal(parseImageFacts('нет такого образа\n'), null)
})

/* ------------------------------------------------------------ в ответе API */

const app = express()
app.use(express.json())
app.use(adminEnvironmentRoutes())
let base = ''
let server: http.Server

before(async () => {
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => server?.close())

let cookie = ''
function staffCookie(): string {
  if (cookie) return cookie
  const teacher = createTeacher({ name: 'Ада', email: 'ada@test.local', role: 'owner' })
  assert.ok(teacher)
  let value = ''
  issueStaffCookie(
    { cookie: (_n: string, v: string) => (value = v) } as unknown as Response,
    teacher,
  )
  cookie = `${STAFF_COOKIE}=${value}`
  return cookie
}

test('строка окружения несёт обе версии: просимую и собранную', async () => {
  const res = await fetch(`${base}/api/admin/environments`, { headers: { cookie: staffCookie() } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    environments: { name: string; python: unknown; pythonBuilt: unknown }[]
  }
  assert.ok(body.environments.length > 0)
  for (const env of body.environments) {
    // Просимая есть всегда: её знает файл, и панели есть что показать до первой
    // сборки. Собранная — только когда образ есть и он о ней рассказал.
    assert.match(String(env.python), /^3\.\d+$/, env.name)
    assert.ok(
      env.pythonBuilt === null || /^3\.\d+/.test(String(env.pythonBuilt)),
      `${env.name}: ${String(env.pythonBuilt)}`,
    )
  }
})

test('опубликованный каталог называет версию сам — или не называет вовсе', () => {
  const entry = (extra: Record<string, unknown>) => ({
    schemaVersion: 1,
    release: 'v1',
    defaultEnvironment: 'base',
    environments: [
      { name: 'base', image: `registry.example/colloq-kernel@sha256:${'a'.repeat(64)}`, gpu: false, ...extra },
    ],
  })
  assert.equal(parseRuntimeCatalog(entry({ python: '3.12' })).environments[0].python, '3.12')
  // Не сказано — и панель промолчит: подставить умолчание значило бы написать
  // версию, которой в чужом неизменном образе может и не быть.
  assert.equal(parseRuntimeCatalog(entry({})).environments[0].python, undefined)
  assert.throws(() => parseRuntimeCatalog(entry({ python: '3.12 или новее' })), /Python/)
  assert.throws(() => parseRuntimeCatalog(entry({ python: 312 })), /Python/)
})

/* ------------------------------------------------------------ и на экране */

/** Разметка без комментариев: объяснение — не обещание. */
const code = (source: string): string =>
  source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

test('строка окружения показывает версию рядом с размером, а не слово «Python»', () => {
  const screen = code(read('web/src/admin/screens/Environments.svelte'))
  // Голое слово стояло здесь с самого начала, и версия — ровно то, ради чего
  // на эту строку смотрят.
  assert.ok(!/'Python',/.test(screen), 'в строке снова слово «Python» без версии')
  assert.match(screen, /pythonLabel\(env\),\n\s*env\.imageBytes/)
  // Показывается собранная версия, пока она совпадает с просимой; разошлись —
  // просимая, и тем же значком «Needs rebuild», что и правка списка.
  assert.match(screen, /env\.pythonBuilt !== null && !pythonStale\(env\)/)
  assert.match(screen, /pythonStale\(env\)\s*\?\s*tr\('admin\.env\.pythonNeedsRebuild'/)
})

test('версию выбирают кнопками, а пишется она в тот же файл', () => {
  const screen = code(read('web/src/admin/screens/Environments.svelte'))
  assert.match(screen, /\{#each PYTHON_VERSIONS as version \(version\)\}/)
  // Кнопка правит текст окружения, а не отдельное поле рядом с ним: файл
  // остаётся единственной правдой, и вписанная руками директива подсвечивает
  // свою кнопку.
  assert.match(screen, /draftSource = withPython\(draftSource, version\)/)
  assert.match(screen, /declaresPython\(draftSource\) \?\? DEFAULT_PYTHON/)
  // Родитель задаёт версию за ребёнка — кнопки заперты и говорят почему.
  assert.match(screen, /disabled=\{draftParent !== null \|\| !editorReady\}/)
  assert.match(screen, /tr\('admin\.env\.pythonFromParent'/)
})

test('форма нового занятия показывает версию окружения и больше не отрицает её', () => {
  const source = read('web/src/admin/screens/NewSeminar.svelte')
  assert.match(code(source), /Python \$\{chosen\.pythonBuilt \?\? chosen\.python\}/)
  // Комментарий обещал обратное — «сервер её не знает»; теперь знает.
  assert.ok(!/Версии Python здесь нет намеренно/.test(source))
})

test('обе подписи про версию есть на двух языках', () => {
  for (const key of [
    'admin.env.pythonVersion',
    'admin.env.pythonHint',
    'admin.env.pythonFromParent',
    'admin.env.pythonFromParentUnknown',
    'admin.env.pythonNotUnderstood',
    'admin.env.pythonConflict',
    'admin.env.pythonNeedsRebuild',
  ]) {
    assert.notEqual(translate('ru', key), key, key)
    assert.notEqual(translate('en', key), key, key)
    assert.doesNotMatch(translate('en', key, { version: '3.12', built: '3.11', parent: 'base', line: '#', list: '3.12' }), /[А-Яа-яЁё]/, key)
  }
})
