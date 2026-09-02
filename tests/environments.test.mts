/**
 * Environments: the packages a seminar's Python has.
 *
 * One environment is one file in `kernel/environments/`, installed on top of
 * the base every kernel carries, and built into the image `colloq-kernel:<name>`.
 * The panel and the `make env-*` targets are two faces of the same directory
 * and the same `KERNEL_ENV` line, which is why the parsing rules live in one
 * place and are pinned here.
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
  listChanged,
  parsePackages,
  pickActiveName,
  readSource,
} from '../server/src/environments.js'
import { adminEnvironmentRoutes } from '../server/src/routes/admin-environments.js'
import { createTeacher } from '../server/src/admin/store.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { ENVIRONMENT_NAME, STAFF_COOKIE } from '../shared/admin.js'

/* ------------------------------------------------ what counts as a package */

test('a package per line, as a person would count them', () => {
  assert.deepEqual(parsePackages('torch>=2.4\ntimm>=1.0\n'), ['torch>=2.4', 'timm>=1.0'])
})

test('comments and blank lines are not packages', () => {
  const source = '# computer vision\n\ntorch>=2.4\n\n#  another note\ntimm>=1.0\n'
  assert.deepEqual(parsePackages(source), ['torch>=2.4', 'timm>=1.0'])
})

test('a pip directive is not a package', () => {
  // Counting these told a room "6 packages" for a file that listed five, which
  // is the sort of small lie that makes the rest of a number untrustworthy.
  const source = '--extra-index-url https://download.pytorch.org/whl/cpu\ntorch>=2.4\n'
  assert.deepEqual(parsePackages(source), ['torch>=2.4'])
})

test('surrounding whitespace does not make two packages out of one', () => {
  assert.deepEqual(parsePackages('  torch>=2.4  \n\t timm \n'), ['torch>=2.4', 'timm'])
})

test('an empty file asks for nothing, and says so without crashing', () => {
  assert.deepEqual(parsePackages(''), [])
  assert.deepEqual(parsePackages('\n\n#только комментарий\n'), [])
})

test('a package with a marker or an extra survives whole', () => {
  const source = "uvicorn[standard]>=0.30\nnumpy>=1.26; python_version < '3.13'\n"
  assert.deepEqual(parsePackages(source), [
    'uvicorn[standard]>=0.30',
    "numpy>=1.26; python_version < '3.13'",
  ])
})

/* ------------------------------------------------------------ the name */

test('a name is what a filename and a Docker tag can both be', () => {
  for (const ok of ['base', 'cv', 'cv-torch-2', 'a', 'nlp-hf']) {
    assert.ok(ENVIRONMENT_NAME.test(ok), ok)
  }
})

test('a name that would escape the directory or break a tag is refused', () => {
  // It becomes a path and an image tag, so this is not cosmetic.
  for (const bad of ['../etc', 'CV', 'cv torch', 'cv.torch', '-cv', 'cv-', '', 'cv/../x', 'cv:latest']) {
    assert.ok(!ENVIRONMENT_NAME.test(bad), bad)
  }
})

test('a name is short enough to read in a table row', () => {
  assert.ok(ENVIRONMENT_NAME.test('a'.repeat(32)))
  assert.ok(!ENVIRONMENT_NAME.test('a'.repeat(33)))
})

/* ------------------------------------------- собрана ли она на самом деле */

/*
 * «Собрана или нет» решалось сравнением времени правки файла со временем
 * сборки образа — то есть отвечало на другой вопрос: не изменился ли список, а
 * трогали ли файл. Открыть список и сохранить не меняя, или просто иметь файл
 * новее образа, собранного через docker compose, — этого хватало, чтобы на
 * рабочей среде повисло «Needs rebuild» рядом с «216 MB · built 5 days ago».
 */
test('сохранение без изменений — не изменение', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'torch>=2.4\ntimm>=1.0\n'), false)
})

test('комментарий и пустая строка не меняют того, что поставит pip', () => {
  assert.equal(
    listChanged('torch>=2.4\ntimm>=1.0\n', '# зрение\n\ntorch>=2.4\n\ntimm>=1.0\n'),
    false,
  )
})

test('тот же список в другом порядке — тот же список', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'timm>=1.0\ntorch>=2.4\n'), false)
})

test('новый пакет — изменение', () => {
  assert.equal(listChanged('torch>=2.4\n', 'torch>=2.4\nnumpy\n'), true)
})

test('другая версия того же пакета — изменение', () => {
  assert.equal(listChanged('torch>=2.4\n', 'torch>=2.5\n'), true)
})

test('убранный пакет — изменение', () => {
  assert.equal(listChanged('torch>=2.4\ntimm>=1.0\n', 'torch>=2.4\n'), true)
})

/* ------------------------------------------ какое окружение по умолчанию */

/*
 * `.env` — файл хоста, и в образе app его нет. Без запасного пути панель под
 * `make up` всегда отвечала «base», а новый семинар записывался на base при
 * собранном ядре cv: имя окружения у семинара решает, из какого образа
 * поднимется его контейнер, когда сервер увидит docker.
 */
test('строка .env решает, пока она есть', () => {
  assert.equal(pickActiveName('PORT=3000\nKERNEL_ENV=cv\n', 'base'), 'cv')
})

test('последняя строка — та, что дописал make env-use', () => {
  assert.equal(pickActiveName('KERNEL_ENV=base\nKERNEL_ENV=nlp\n', undefined), 'nlp')
})

test('без файла берётся то, что compose передал контейнеру', () => {
  assert.equal(pickActiveName(null, 'cv'), 'cv')
})

test('в файле нет строки — тоже переменная окружения', () => {
  assert.equal(pickActiveName('PORT=3000\n', 'cv'), 'cv')
})

test('нет ни файла, ни переменной — base', () => {
  assert.equal(pickActiveName(null, undefined), 'base')
  assert.equal(pickActiveName('KERNEL_ENV=\n', ''), 'base')
})

test('имя, которым не может быть ни файл, ни тег, не считается', () => {
  // Оно уходит в путь и в имя образа, поэтому проверяется здесь, а не там.
  assert.equal(pickActiveName('KERNEL_ENV=../etc\n', undefined), 'base')
  assert.equal(pickActiveName('KERNEL_ENV=CV\n', 'cv'), 'cv')
})

/* ------------------------------------------- создание против перезаписи */

/**
 * PUT одинаков для «завёл окружение» и «поправил список», а намерения разные.
 *
 * Форма «New environment» шлёт тот же запрос, и на занятом имени она молча
 * затирала чужой список пакетов целиком — истории у этих файлов нет, вернуть
 * нечем. `If-None-Match: *` — это «только если такого ещё нет».
 */
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

/**
 * issueStaffCookie пишет в express-овый Response; это самое малое, что им является.
 *
 * Преподаватель заводится один на всю сюиту: адрес уникален индексом, и второй
 * вызов с тем же вернул бы null, а не второе печенье.
 */
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

test('создание по занятому имени отказывает, а не переписывает список', async () => {
  const before = readSource('base')
  const res = await fetch(`${base}/api/admin/environments/base`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'if-none-match': '*',
      cookie: staffCookie(),
    },
    body: JSON.stringify({ name: 'base', source: '# пусто\n' }),
  })
  assert.equal(res.status, 409)
  const body = (await res.json()) as { reason?: string }
  assert.equal(body.reason, 'exists')
  // Главное: файл не тронут — иначе отказ был бы вежливостью после потери.
  assert.equal(readSource('base'), before)
})

/* ------------------------------- своё ядро у комнаты или общее на всех */

/**
 * Признак едет вместе со списком, потому что показывают его там же.
 *
 * Панель обещала контейнер на семинар безусловно, а на установке без docker или
 * с KERNEL_ISOLATION=off это неправда сразу в двух местах: комнаты видят файлы
 * друг друга, и «Make default» действительно забирает переменные у открытых
 * семинаров. Знает об этом только сервер — значит, он и говорит.
 */
test('список окружений говорит, делят ли комнаты одно ядро', async () => {
  const res = await fetch(`${base}/api/admin/environments`, { headers: { cookie: staffCookie() } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { environments?: unknown; shared?: unknown }
  assert.ok(Array.isArray(body.environments))
  // Булево, а не «поля нет»: `undefined` панель читает как «всё в порядке».
  assert.equal(typeof body.shared, 'boolean')
  // Изоляция в сюите выключена (tests/_env.mts), так что ядро тут общее.
  assert.equal(body.shared, true)
})

/* ------------------------------------ .env.example против docker-compose */

/**
 * Каждая строка из .env.example доезжает до контейнера app.
 *
 * compose читает .env только для подстановки: переменная, не названная в
 * `environment:`, до сервера внутри контейнера не доходит вовсе. Так
 * `MAX_SESSION_MB=200` и `AI_REASONING=true` молча не работали под `make up`,
 * хотя и README, и .env.example их обещали, а `make run` те же строки
 * применял — два режима одного инстанса вели себя по-разному, и заметить это
 * можно было только по загруженному в комнату лишнему гигабайту.
 */
test('переменная, обещанная в .env.example, доезжает до контейнера', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const documented = readFileSync(path.join(root, '.env.example'), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf('=')))
  assert.ok(documented.length > 10, 'разбор .env.example ничего не нашёл')

  const compose = readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')
  const app = compose.slice(compose.indexOf('\n  app:'), compose.indexOf('\n  kernel:'))
  // Единственное исключение: PORT — это порт НА ХОСТЕ, он уходит в ports, а
  // внутри контейнера сервер всегда слушает 3000.
  const hostOnly = new Set(['PORT'])
  for (const name of documented) {
    if (hostOnly.has(name)) continue
    assert.match(
      app,
      new RegExp(`\\n +${name}: `),
      `${name} обещан в .env.example, но в контейнер app не передаётся`,
    )
  }
})
