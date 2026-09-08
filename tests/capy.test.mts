/**
 * Таблица рекордов капибары: чьё имя и кто в таблицу попадает.
 *
 * Сервис (scripts/relay-capy.py) живёт на ретрансляторе и до сих пор проверялся
 * только руками — а сломано в нём было два правила из тех, что видит комната.
 *
 * ПЕРВОЕ: имя можно было взять чужое. Проверка «имя закреплено за другим
 * владельцем — 409» стояла ВНУТРИ `if name != ANON and owner`, то есть
 * спрашивалась только у того, кто ключ владельца прислал. Запрос без ключа —
 * `curl` в три строки — писал что угодно под любым именем и переписывал чужой
 * рекорд. Правило было, обойти его можно было тем, что его не спрашивали.
 *
 * ВТОРОЕ: безымянные попытки. Пустое имя становилось «Анонимом», и каждая
 * такая попытка занимала СВОЮ вечную строку: на живой таблице из восьми строк
 * пять были «Анонимами». Теперь строка в таблице начинается с имени; играть без
 * имени можно сколько угодно, а прежние безымянные строки остались в файле,
 * считаются в попытках и не показываются.
 *
 * Проверяется настоящий сервис на своём порту с временным файлом: правила
 * живут в нём, а не в копии на TypeScript, и переписать их мимо теста нельзя.
 * Адрес для лимита берётся из последнего элемента X-Forwarded-For — у каждой
 * проверки он свой, иначе корзина на пять записей кончится на середине файла.
 */
import './_env.mts'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

const python = spawnSync('python3', ['--version'])
const HAVE_PYTHON = python.status === 0

const OWNER_A = 'a1b2c3d4e5f60718'
const OWNER_B = 'ffffffffffffffff'

/** Свободный порт: сервис слушает настоящий сокет. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as net.AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

let service: ChildProcess | null = null
let base = ''
let root = ''

async function up(): Promise<void> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'capy-test-'))
  fs.mkdirSync(path.join(root, 'state'), { recursive: true })
  /*
   * Наследство живой машины: безымянная строка и именная без владельца —
   * обе записаны до нынешних правил. Первая не должна показываться, вторую
   * забирает первый, кто запишется под этим именем со своим ключом.
   */
  fs.writeFileSync(
    path.join(root, 'state', 'scores.json'),
    JSON.stringify([
      { id: 'старая-безымянная', name: 'Аноним', score: 592, at: 1 },
      { id: 'старая-ничья', name: 'Ule4ka', score: 854, at: 2 },
    ]),
  )
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  service = spawn('python3', [path.resolve(import.meta.dirname, '..', 'scripts/relay-capy.py')], {
    env: { ...process.env, CAPY_STATE: path.join(root, 'state'), CAPY_PORT: String(port) },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${base}/.relay/capy/scores`)
      if (r.ok) return
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('сервис капибары не поднялся')
}

function down(): void {
  service?.kill('SIGKILL')
  if (root) fs.rmSync(root, { recursive: true, force: true })
}

interface Answer {
  status: number
  body: Record<string, any>
}

/** Жетон забега: без него запись не принимается вовсе. */
async function runToken(): Promise<string> {
  const r = await fetch(`${base}/.relay/capy/start`)
  return ((await r.json()) as { run: string }).run
}

/** Записать очки. `from` — свой адрес у каждой проверки, ради лимита. */
async function send(
  from: string,
  body: Record<string, unknown>,
  withRun = true,
): Promise<Answer> {
  const payload = withRun ? { run: await runToken(), ...body } : body
  const r = await fetch(`${base}/.relay/capy/scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': from },
    body: JSON.stringify(payload),
  })
  return { status: r.status, body: (await r.json()) as Record<string, any> }
}

async function scores(): Promise<Record<string, any>> {
  const r = await fetch(`${base}/.relay/capy/scores`)
  return (await r.json()) as Record<string, any>
}

const suite = test.suite ?? test.describe

suite('таблица рекордов капибары', { skip: HAVE_PYTHON ? false : 'нет python3' }, () => {
  test.before(up)
  test.after(down)

  test('прежние безымянные строки не показываются, но в попытках считаются', async () => {
    const board = await scores()
    assert.deepEqual(
      board.top.map((r: any) => r.name),
      ['Ule4ka'],
      'в таблице снова «Аноним»',
    )
    // Попытка была, и человек её сделал: считать её честно.
    assert.equal(board.total, 2)
    assert.equal(board.names, 1, 'безымянные строки посчитаны за имя')
  })

  test('имя со своим ключом записывается', async () => {
    const { status, body } = await send('10.0.0.1', {
      name: 'sleep3r',
      score: 30,
      owner: OWNER_A,
    })
    assert.equal(status, 200)
    assert.equal(body.name, 'sleep3r')
    assert.equal(body.best, 30)
  })

  test('чужой ключ на занятое имя — 409, и рекорд владельца цел', async () => {
    const { status, body } = await send('10.0.0.2', {
      name: 'SLEEP3R',
      score: 45,
      owner: OWNER_B,
    })
    assert.equal(status, 409, 'имя отдали другому владельцу')
    assert.equal(body.error, 'name taken')
    const board = await scores()
    const mine = board.top.find((r: any) => r.name === 'sleep3r')
    assert.equal(mine.score, 30, 'чужая запись переписала рекорд')
  })

  test('без ключа владельца имя не занять — 400', async () => {
    // Та самая дыра: проверка 409 просто не спрашивалась, если ключа нет.
    const { status, body } = await send('10.0.0.3', { name: 'sleep3r', score: 45 })
    assert.equal(status, 400)
    assert.equal(body.error, 'owner')
    const board = await scores()
    assert.equal(board.top.find((r: any) => r.name === 'sleep3r').score, 30)
  })

  test('мусорный ключ владельца — тот же отказ, а не «ключа нет»', async () => {
    for (const owner of ['нет', '', 'abc', 'ZZZZZZZZZZZZZZZZ', 'a1b2c3d4e5f6071']) {
      const { status, body } = await send('10.0.0.4', { name: 'sleep3r', score: 45, owner })
      assert.equal(status, 400, `ключ ${JSON.stringify(owner)} приняли`)
      assert.equal(body.error, 'owner')
    }
  })

  test('без имени записи нет', async () => {
    for (const name of ['', '   ', '​​', undefined]) {
      const { status, body } = await send('10.0.0.5', { name, score: 40, owner: OWNER_B })
      assert.equal(status, 400, `имя ${JSON.stringify(name)} приняли`)
      assert.equal(body.error, 'name')
    }
    const board = await scores()
    assert.ok(
      !board.top.some((r: any) => r.name === 'Аноним'),
      'безымянная попытка снова завела строку',
    )
  })

  test('«Аноним» — не имя: его не занять', async () => {
    // Заняв его, человек получил бы вместе с ним прежние безымянные строки.
    for (const name of ['Аноним', 'аноним', ' АНОНИМ ']) {
      const { status, body } = await send('10.0.0.6', { name, score: 40, owner: OWNER_B })
      assert.equal(status, 400, `«${name}» приняли за имя`)
      assert.equal(body.error, 'name')
    }
  })

  test('ничью строку забирает первый, кто запишется под ней со своим ключом', async () => {
    const first = await send('10.0.0.7', { name: 'Ule4ka', score: 20, owner: OWNER_B })
    assert.equal(first.status, 200)
    assert.equal(first.body.best, 854, 'старый рекорд под этим именем потерян')
    // А второму — уже занято.
    const second = await send('10.0.0.8', { name: 'ule4ka', score: 20, owner: OWNER_A })
    assert.equal(second.status, 409)
  })

  test('смена имени: строки владельца переезжают вместе с рекордом', async () => {
    const { status, body } = await send('10.0.0.9', { name: 'Соня', score: 10, owner: OWNER_A })
    assert.equal(status, 200)
    assert.equal(body.renamed, true, 'прежние строки остались под старым именем')
    assert.equal(body.best, 30, 'рекорд не переехал вместе с именем')
    const board = await scores()
    assert.ok(!board.top.some((r: any) => r.name === 'sleep3r'), 'старое имя осталось в таблице')
    assert.equal(board.top.find((r: any) => r.name === 'Соня').score, 30)
  })

  test('в таблице по строке на имя и ни одного «Анонима»', async () => {
    const board = await scores()
    const names = board.top.map((r: any) => r.name)
    assert.deepEqual(new Set(names).size, names.length, 'имя повторяется')
    assert.ok(!names.includes('Аноним'))
    assert.equal(board.names, names.length)
  })
})
