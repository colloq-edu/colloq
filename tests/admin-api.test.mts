/**
 * Что панель на самом деле кладёт в запрос.
 *
 * Два места, где расхождение клиента с сервером стоило занятия и не падало
 * никакой сборкой. Тетрадь с диска ехала целиком, вместе с выводами: тело
 * запроса ограничено мегабайтом, а прогнанная тетрадь с парой графиков — это
 * мегабайты base64, и дверь отвечала «internal error» на файл, про который сама
 * же обещала «outputs are dropped». Удаление семинара никогда не спрашивало о
 * судьбе публичной страницы, хотя сервер этот вопрос объявляет отдельным: копия
 * тетради оставалась открытой всем, и снять её было уже нечем.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adminApi } from '../web/src/lib/adminApi.js'

interface Seen {
  url: string
  init: RequestInit | undefined
}

/** Подменяет fetch и возвращает то, что панель попыталась отправить. */
async function capture(run: () => Promise<unknown>): Promise<Seen> {
  const seen: Seen[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), init })
    return {
      ok: true,
      status: 204,
      headers: new Headers({ 'content-length': '0' }),
      json: async () => ({}),
    } as unknown as Response
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = real
  }
  assert.equal(seen.length, 1, 'ровно один запрос')
  return seen[0]
}

const bodyOf = (seen: Seen): Record<string, unknown> =>
  JSON.parse(String(seen.init?.body ?? '{}')) as Record<string, unknown>

/* ------------------------------------------------------- тетрадь с диска */

test('импорт тетради шлёт ячейки, а не файл целиком', async () => {
  const cells = [
    { cell_type: 'code', source: 'print(1)' },
    { cell_type: 'markdown', source: '# hello' },
  ]
  const seen = await capture(() => adminApi.importNotebook({ cells, filename: 'week07.ipynb' }))

  assert.equal(seen.url, '/api/admin/import/notebook')
  const body = bodyOf(seen)
  assert.deepEqual(body.cells, cells)
  // Поле с текстом файла ушло совсем: именно оно и не пролезало в предел.
  assert.equal('notebook' in body, false)
})

test('выводы в тело запроса не попадают', async () => {
  // Ровно то, что делает экран: из ячейки берутся тип и текст, остальное — нет.
  const raw = {
    cell_type: 'code',
    source: 'plt.show()',
    outputs: [{ data: { 'image/png': 'A'.repeat(4096) } }],
    execution_count: 7,
  }
  const stripped = { cell_type: raw.cell_type, source: raw.source }
  const seen = await capture(() =>
    adminApi.importNotebook({ cells: [stripped], filename: 'plots.ipynb' }),
  )

  const sent = String(seen.init?.body ?? '')
  assert.equal(sent.includes('image/png'), false)
  assert.equal(sent.includes('execution_count'), false)
  assert.ok(sent.length < 1024, 'тело измеряется сотнями байт, а не мегабайтами')
})

/* ------------------------------------------------ удаление и его страница */

test('по умолчанию страница остаётся: розданную ссылку не отозвать', async () => {
  const seen = await capture(() => adminApi.deleteSeminar('abc12345'))
  assert.equal(seen.url, '/api/admin/seminars/abc12345')
  assert.equal(seen.init?.method, 'DELETE')
})

test('согласие снять страницу доезжает до сервера параметром', async () => {
  const seen = await capture(() => adminApi.deleteSeminar('abc12345', true))
  assert.equal(seen.url, '/api/admin/seminars/abc12345?reading=drop')
  assert.equal(seen.init?.method, 'DELETE')
})

test('страницу без комнаты можно снять по её собственному адресу', async () => {
  const seen = await capture(() => adminApi.withdrawPublication('p0000001'))
  assert.equal(seen.url, '/api/admin/publications/p0000001')
  assert.equal(seen.init?.method, 'DELETE')
})
