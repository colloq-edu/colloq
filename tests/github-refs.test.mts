/**
 * Ветка со слэшем: `release/2024`, `feature/x`, `students/2026-fall`.
 *
 * Адрес такой ветки в браузере выглядит ровно как адрес обычной —
 * `/o/r/tree/release/2024/week1`, — и по нему не видно, где кончается имя ветки
 * и начинается путь. Разбор берёт первый сегмент, GitHub отвечает 404, а
 * сервер переводил это в «нет такого или репозиторий приватный»: преподаватель
 * шёл искать опечатку в ссылке, с которой всё в порядке, или делать публичным
 * репозиторий, который и так публичный.
 *
 * Сети здесь нет: `fetch` подменён на время теста. Проверяется не GitHub, а
 * наше поведение — сколько запросов, в каком порядке и что уходит наверх, если
 * догадка не удалась.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listDirectory, resolveRef, type GithubTarget } from '../server/src/github.js'

const real = globalThis.fetch

interface Call {
  url: string
}

/**
 * Подделка `fetch`: карта «кусок адреса → ответ». Всё, чего в карте нет, —
 * 404, потому что именно так GitHub отвечает и на «нет такого», и на «не для
 * вас».
 */
function fakeGithub(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input)
    calls.push({ url })
    for (const [needle, body] of Object.entries(routes)) {
      if (!url.includes(needle)) continue
      return {
        ok: true,
        status: 200,
        json: async () => body,
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
      } as unknown as Response
    }
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
  }) as typeof fetch
  return calls
}

function restore(): void {
  globalThis.fetch = real
}

const target = (over: Partial<GithubTarget> = {}): GithubTarget => ({
  owner: 'o',
  repo: 'r',
  ref: 'release',
  path: '2024/week1',
  kind: 'dir',
  ...over,
})

test('ветка со слэшем узнаётся по списку веток, а не по фразе про приватность', async () => {
  const calls = fakeGithub({
    'branches?per_page=100': [{ name: 'main' }, { name: 'release/2024' }],
    'contents/week1?ref=release%2F2024': [
      { name: 'nb.ipynb', path: 'week1/nb.ipynb', type: 'file', size: 10, download_url: 'https://raw/nb' },
    ],
  })
  try {
    const entries = await listDirectory(target())
    assert.deepEqual(entries.map((e) => e.name), ['nb.ipynb'])
    /*
     * Три запроса и именно в этом порядке: сперва как разобрали, потом — только
     * после 404 — список веток, потом заново. Спрашивать ветки заранее нельзя:
     * анонимных запросов к GitHub шестьдесят в час, а импорт и так стоит два.
     */
    assert.equal(calls.length, 3, calls.map((c) => c.url).join('\n'))
    assert.match(calls[0]?.url ?? '', /contents\/2024\/week1\?ref=release$/)
    assert.match(calls[1]?.url ?? '', /branches\?per_page=100$/)
    assert.match(calls[2]?.url ?? '', /contents\/week1\?ref=release%2F2024$/)
  } finally {
    restore()
  }
})

test('живой ответ не платит за догадку: ветки не спрашиваются вовсе', async () => {
  const calls = fakeGithub({ 'contents/week02?ref=main': [] })
  try {
    await listDirectory(target({ ref: 'main', path: 'week02' }))
    assert.equal(calls.length, 1, 'лишний запрос к GitHub на каждом успешном импорте')
  } finally {
    restore()
  }
})

test('если такой ветки нет, наверх уходит первоначальный отказ, а не выдуманный', async () => {
  fakeGithub({ 'branches?per_page=100': [{ name: 'main' }] })
  try {
    await assert.rejects(
      () => listDirectory(target()),
      // Та самая фраза про приватность — она здесь и правда единственный
      // честный ответ: ветки с таким именем в репозитории нет.
      /repository is private/,
    )
  } finally {
    restore()
  }
})

test('из двух подходящих веток берётся самая длинная', async () => {
  // `release/2024/hotfix` бьёт `release/2024`, а тот — голое `release`:
  // иначе путь уехал бы вместе с куском имени ветки.
  fakeGithub({
    'branches?per_page=100': [
      { name: 'release' },
      { name: 'release/2024' },
      { name: 'release/2024/hotfix' },
    ],
  })
  try {
    const fixed = await resolveRef(target({ path: '2024/hotfix/week1' }))
    assert.equal(fixed.ref, 'release/2024/hotfix')
    assert.equal(fixed.path, 'week1')
  } finally {
    restore()
  }
})

test('ветка длиной во весь путь оставляет корень репозитория, а не хвост от имени', async () => {
  fakeGithub({ 'branches?per_page=100': [{ name: 'students/2026-fall' }] })
  try {
    const fixed = await resolveRef(target({ ref: 'students', path: '2026-fall' }))
    assert.equal(fixed.ref, 'students/2026-fall')
    assert.equal(fixed.path, '')
  } finally {
    restore()
  }
})

test('без пути догадываться не о чем, и запрос не тратится', async () => {
  const calls = fakeGithub({})
  try {
    const same = await resolveRef(target({ ref: 'main', path: '' }))
    assert.equal(same.ref, 'main')
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})
