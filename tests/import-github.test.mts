/**
 * Импорт с GitHub — через настоящий маршрут, а не мимо него.
 *
 * Дверей у создания семинара три, и правила комнаты пишутся ровно один раз, при
 * создании: подправить их потом негде. Одна из трёх однажды правила и потеряла —
 * «From GitHub» + «Teacher only» + «Oracle: off» заводило комнату, где запускать
 * может каждый, а оракул отвечает. Регрессию закрыли, и на неё написали тест —
 * который звал `setRules` и `getRules` напрямую, то есть ту самую регрессию
 * пропустил бы целиком: маршрут импорта в нём не участвовал вовсе.
 *
 * Здесь ходят по маршруту. Сеть подменена: GitHub отвечает из таблицы ниже, а
 * всё остальное (в том числе свой же http-сервер этого файла) уходит настоящим
 * `fetch`. Проверяются обе формы ссылки, которые человек может скопировать из
 * адресной строки, — на файл и на папку недели, — потому что ветки в маршруте у
 * них разные, а правила обязаны доехать по обеим.
 */
import './_env.mts'
import http from 'node:http'
import express from 'express'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Response as ExpressResponse } from 'express'
import { STAFF_COOKIE } from '../shared/admin.js'
import { issueStaffCookie } from '../server/src/admin/auth.js'
import { createTeacher, oldestOwner } from '../server/src/admin/store.js'
import { adminImportRoutes } from '../server/src/routes/admin-import.js'
import { storedRules } from '../server/src/db.js'
import { COUNCIL_ROOM, LECTURE_ROOM, OPEN_ROOM } from '../shared/rules.js'
import { readText } from '../server/src/workspace.js'

/* --------------------------------------------------------- поддельный GitHub */

const NOTEBOOK = JSON.stringify({
  cells: [
    { cell_type: 'markdown', source: ['# Неделя 1\n'] },
    { cell_type: 'code', source: ['import pandas as pd\n', "df = pd.read_csv('train.csv')\n"] },
  ],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
})

/** Что отвечает подделка на каждый адрес. Всё, чего здесь нет, — 404. */
const served = new Map<string, string>([
  [
    'https://api.github.com/repos/hse/ml/contents/week1?ref=main',
    JSON.stringify([
      {
        name: 'lab.ipynb',
        path: 'week1/lab.ipynb',
        type: 'file',
        size: NOTEBOOK.length,
        download_url: 'https://raw.githubusercontent.com/hse/ml/main/week1/lab.ipynb',
      },
      {
        name: 'train.csv',
        path: 'week1/train.csv',
        type: 'file',
        size: 8,
        download_url: 'https://raw.githubusercontent.com/hse/ml/main/week1/train.csv',
      },
    ]),
  ],
  ['https://raw.githubusercontent.com/hse/ml/main/week1/lab.ipynb', NOTEBOOK],
  ['https://raw.githubusercontent.com/hse/ml/main/week1/train.csv', 'a,b\n1,2\n'],
])

const realFetch = globalThis.fetch
/** Куда подделка ходила: по этому видно, что маршрут правда сходил в сеть. */
let asked: string[] = []

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

let base = ''
let server: http.Server
let cookie = ''

before(async () => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    if (!/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(url)) {
      return realFetch(input, init)
    }
    asked.push(url)
    const body = served.get(url)
    if (body === undefined) return Promise.resolve(new Response('{}', { status: 404 }))
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  }) as typeof fetch

  createTeacher({ name: 'Ада', email: 'ada@import.test', role: 'owner' })
  const owner = oldestOwner()
  assert.ok(owner, 'у инстанса нет владельца — импортировать некому')
  let value = ''
  issueStaffCookie(
    { cookie: (_n: string, v: string) => (value = v) } as unknown as ExpressResponse,
    owner,
  )
  cookie = `${STAFF_COOKIE}=${value}`

  const app = express()
  app.use(express.json())
  app.use(adminImportRoutes())
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => {
  globalThis.fetch = realFetch
  server?.close()
})

interface Made {
  id: string
  cells: number
  files: string[]
  skipped: string[]
}

async function importFrom(body: Record<string, unknown>): Promise<Made> {
  asked = []
  const res = await realFetch(`${base}/api/admin/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  // Тело читается один раз: `await res.text()` внутри сообщения утверждения
  // съедает его и до `res.json()` уже ничего не доходит.
  const answered = await res.text()
  assert.equal(res.status, 201, `импорт ответил ${res.status}: ${answered}`)
  return JSON.parse(answered) as Made
}

const FILE_URL = 'https://github.com/hse/ml/blob/main/week1/lab.ipynb'
const FOLDER_URL = 'https://github.com/hse/ml/tree/main/week1'

/* -------------------------------------------------------------------- тесты */

test('ссылка на тетрадь заводит комнату с её ячейками и с её правилами', async () => {
  const made = await importFrom({
    url: FILE_URL,
    name: 'Неделя 1',
    rules: { run: 'host', oracle: 'off' },
  })
  assert.ok(asked.includes('https://raw.githubusercontent.com/hse/ml/main/week1/lab.ipynb'))
  assert.equal(made.cells, 2, 'ячейки чужой тетради не доехали')

  const rules = storedRules(made.id)
  assert.equal(rules.run, 'host', 'правило запуска потеряно маршрутом импорта')
  assert.equal(rules.oracle, 'off', 'оракул остался включённым в комнате, где его выключили')
  assert.equal(rules.edit, OPEN_ROOM.edit, 'нетронутое правило поехало вместе с присланным')

  // И тетрадь легла на диск сразу, а не через полторы секунды после первого
  // входа: панель считает файлы свежего семинара прямо здесь.
  const projected = readText(made.id, 'Тетрадь.ipynb')?.text ?? ''
  assert.match(projected, /import pandas as pd/, 'тетради нет в папке комнаты')
})

test('ссылка на папку недели везёт и соседние файлы, и те же правила', async () => {
  const made = await importFrom({
    url: FOLDER_URL,
    name: 'Неделя 1, папкой',
    rules: { run: 'host', files: 'host' },
  })
  assert.deepEqual(made.files, ['train.csv'], 'данные рядом с тетрадью не приехали')
  assert.deepEqual(made.skipped, [])
  assert.equal(readText(made.id, 'train.csv')?.text, 'a,b\n1,2\n')

  const rules = storedRules(made.id)
  assert.equal(rules.run, 'host')
  assert.equal(rules.files, 'host')
})

test('режим — тоже правило, и он доезжает по обеим ссылкам', async () => {
  /*
   * Пресет режима и подкрученная строка поверх него: панель всегда шлёт полный
   * `rules` рядом с `mode` и эту половину прячет, а скрипт или клиент постарше
   * шлёт один `mode`.
   */
  const lecture = await importFrom({ url: FILE_URL, name: 'Лекция', mode: 'lecture' })
  assert.deepEqual(storedRules(lecture.id), LECTURE_ROOM)

  const council = await importFrom({ url: FOLDER_URL, name: 'Консилиум', mode: 'council' })
  assert.deepEqual(storedRules(council.id), COUNCIL_ROOM)

  const mixed = await importFrom({
    url: FILE_URL,
    name: 'Лекция, где спрашивают',
    mode: 'lecture',
    rules: { oracle: 'hints' },
  })
  assert.deepEqual(storedRules(mixed.id), { ...LECTURE_ROOM, oracle: 'hints' })
})

test('без правил и без режима импорт заводит ту же открытую комнату, что и всегда', async () => {
  const made = await importFrom({ url: FILE_URL, name: 'Как обычно' })
  assert.deepEqual(storedRules(made.id), OPEN_ROOM)
})

test('чужой чепухи в rules комната не принимает', async () => {
  // Тело запроса — от кого угодно со штатной кукой, в том числе от старого
  // клиента. Незнакомое значение обязано осесть в разрешающем умолчании, а не
  // лечь в базу как есть: `readRules` — единственная дверь к столбцу.
  const made = await importFrom({
    url: FILE_URL,
    name: 'Чепуха',
    rules: { run: 'nobody', oracle: 'maybe', выдумка: 1 },
  })
  const rules = storedRules(made.id)
  assert.equal(rules.run, OPEN_ROOM.run)
  assert.equal(rules.oracle, OPEN_ROOM.oracle)
  assert.equal(JSON.stringify(rules).includes('выдумка'), false, 'в правила уехало чужое поле')
})
