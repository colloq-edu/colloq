/**
 * Экран публикации: два места, где панель молчала о том, что уже знала.
 *
 * Первое — момент, который не стал шагом. Преподаватель отмечал семь, получал
 * страницу с шестью и пересчитывал рельсу глазами: пустая или нечитаемая
 * версия выпадала без единого слова. Теперь сервер называет выпавшие поимённо
 * (shared/publish.ts · SkippedStep), и здесь проверяется, что панель умеет
 * назвать их человеку — той же копией причин, что и сервер.
 *
 * Второе — отказ «адрес уже занят», за которым стоит не чужая живая страница, а
 * память о розданной ссылке. Такое имя владелец может отпустить сам, но только
 * если отказ сказал, кто его держит. Проверяется разбор этого ответа — включая
 * случай, когда сервер о держателе молчит: тогда панель обязана вести себя как
 * раньше и ничего не предлагать.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SKIP_REASON_TEXT, type SkipReason } from '../shared/publish.js'
import { skippedStepLine } from '../web/src/admin/panel.js'
import { AdminApiError, addressHolderOf, adminApi } from '../web/src/lib/adminApi.js'

/* ------------------------------------------------- момент, ставший ничем */

test('у каждой причины своё слово, и это слово общее с сервером', () => {
  const reasons: SkipReason[] = ['empty', 'broken', 'unnamed', 'duplicate']
  const said = new Set<string>()
  for (const reason of reasons) {
    const line = skippedStepLine({ seq: 4, label: 'перед упражнением', reason })
    // Причина берётся из shared, а не переписывается здесь второй копией.
    assert.ok(
      line.includes(SKIP_REASON_TEXT[reason]),
      `${reason}: строка не называет причину словами сервера`,
    )
    said.add(line)
  }
  assert.equal(said.size, reasons.length, 'две разные причины сказаны одинаково')
})

test('момент назван так, как его назвал преподаватель', () => {
  const line = skippedStepLine({ seq: 12, label: 'версия, которая ломалась', reason: 'empty' })
  assert.ok(line.includes('версия, которая ломалась'))
  // Номер версии — не имя момента: его в ленте у студента никто не видит.
  assert.doesNotMatch(line, /12/)
})

test('безымянный момент зовут по времени, а не молчат о нём', () => {
  const line = skippedStepLine({ seq: 12, label: '   ', reason: 'unnamed' }, '14:05, 3 сентября')
  assert.ok(line.includes('14:05, 3 сентября'))
  assert.ok(line.includes(SKIP_REASON_TEXT.unnamed))
})

test('когда нечем назвать вовсе — номер версии, но строка есть', () => {
  // Кандидата в списке уже нет (историю подрезали), и время взять неоткуда.
  const line = skippedStepLine({ seq: 41, label: '', reason: 'broken' })
  assert.ok(line.includes('41'), 'без номера строка не показывает вообще ничего')
  assert.ok(line.includes(SKIP_REASON_TEXT.broken))
})

/* ------------------------------------------------- кто держит имя адреса */

const refusal = (body: unknown): AdminApiError =>
  new AdminApiError('Адрес «ml-2025» уже занят.', 409, 'invalid', body)

test('держатель прежнего имени доезжает до панели целиком', () => {
  const holder = addressHolderOf(
    refusal({
      error: 'Адрес «ml-2025» уже занят.',
      reason: 'invalid',
      holder: { kind: 'course', id: 'c0000001', name: 'ML 2025', former: true },
    }),
  )
  assert.deepEqual(holder, { kind: 'course', id: 'c0000001', name: 'ML 2025', former: true })
})

test('живой чужой адрес отличим от прежнего: former едет как есть', () => {
  const holder = addressHolderOf(
    refusal({ holder: { kind: 'publication', id: 'p0000009', name: 'Неделя 1', former: false } }),
  )
  // Отпускать здесь нечего, и панель обязана видеть это по ответу, а не гадать.
  assert.equal(holder?.former, false)
})

test('молчание сервера о держателе — не выдумка держателя', () => {
  // Пока сервер называет только факт («уже занят»), экран ведёт себя как
  // раньше: показывает фразу отказа и ничего отпустить не предлагает.
  assert.equal(addressHolderOf(refusal({ error: 'Адрес «ml-2025» уже занят.' })), null)
  assert.equal(addressHolderOf(refusal(null)), null)
})

test('мусор в ответе не становится кнопкой', () => {
  for (const holder of [
    { kind: 'seminar', id: 'x', name: 'x', former: true },
    { kind: 'course', name: 'без идентификатора', former: true },
    { kind: 'course', id: '', name: 'пустой', former: true },
    'ml-2025',
    42,
  ]) {
    assert.equal(addressHolderOf(refusal({ holder })), null, JSON.stringify(holder))
  }
})

test('чужой отказ — не про адрес: 404 держателя не называет', () => {
  const notFound = new AdminApiError('not found', 404, 'invalid', {
    holder: { kind: 'course', id: 'c0000001', name: 'ML 2025', former: true },
  })
  assert.equal(addressHolderOf(notFound), null)
  assert.equal(addressHolderOf(new Error('сеть')), null)
})

/* ---------------------------------------------- отпустить прежнее имя */

test('отпускают прежнее имя у его держателя, а не у того, кому оно нужно', async () => {
  const seen: { url: string; init?: RequestInit }[] = []
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
    await adminApi.releaseFormerSlug('course', 'c0000001', 'ml-2025')
  } finally {
    globalThis.fetch = real
  }

  assert.equal(seen.length, 1)
  // Идентификатор в адресе — держателя: сервер отпускает имя только своему
  // владельцу (server/src/publish/store.ts · releaseFormerSlug).
  assert.equal(seen[0].url, '/api/admin/slug/course/c0000001/former/ml-2025')
  assert.equal(seen[0].init?.method, 'DELETE')
})
