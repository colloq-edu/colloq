/**
 * «Комнаты нет» — и чем оно отличается от «сервера не слышно».
 *
 * По этому различию клиент делает необратимое: стирает базу y-indexeddb этой
 * комнаты вместе со всем, что человек напечатал офлайн, гасит личность и пишет
 * «Этот семинар удалён». Пока признаком был голый код 404, любой слой перед
 * бэкендом — ретранслятор без подключённого frpc, статика, раздающая
 * index.html на всё подряд, неверный upstream — превращал перебой связи в
 * стирание кэша у всего класса разом.
 *
 * Проверяется здесь, а не в браузере, ровно потому, что отказывает молча: с
 * точки зрения экрана обе ветки выглядят как «сервер ответил 404».
 */
import { test } from 'node:test'
import { setLocaleResolver } from '../shared/i18n.js'
import assert from 'node:assert/strict'
import { SESSION_MISSING, saysSessionMissing } from '../shared/protocol.js'
import { ApiError, statusMessage } from '../web/src/lib/api.js'

test('сервер сказал словами — комнаты правда нет', () => {
  assert.equal(saysSessionMissing(new ApiError(SESSION_MISSING, 404)), true)
})

test('чужой 404 без тела — это обрыв связи, а не приговор комнате', () => {
  /*
   * Так его собирает api.ts, когда тела нет или оно не JSON: ретранслятор
   * отдаёт свою страницу, HTTP/2 не несёт строки состояния, и до экрана
   * доезжает «Not found (404)».
   */
  try {
    for (const [locale, expected] of [
      ['ru', 'Не найдено (404)'],
      ['en', 'Not found (404)'],
    ] as const) {
      setLocaleResolver(() => locale)
      const proxied = new ApiError(
        statusMessage({ status: 404, statusText: 'Not Found' } as Response),
        404,
      )
      assert.equal(proxied.message, expected)
      assert.equal(saysSessionMissing(proxied), false)
    }
  } finally {
    setLocaleResolver(() => 'ru')
  }
})

test('чужие слова с нашим кодом тоже не считаются', () => {
  for (const words of ['Not Found', 'session gone', 'not found', '', 'SESSION NOT FOUND']) {
    assert.equal(saysSessionMissing(new ApiError(words, 404)), false, words)
  }
})

test('наши слова с чужим кодом не считаются тем более', () => {
  for (const status of [0, 400, 403, 410, 500, 502, 503]) {
    assert.equal(saysSessionMissing(new ApiError(SESSION_MISSING, status)), false, String(status))
  }
})

test('сеть отвалилась — ApiError с кодом 0, и комната цела', () => {
  const offline = new ApiError(
    'Could not reach the server — check the connection and try again.',
    0,
  )
  assert.equal(saysSessionMissing(offline), false)
})

test('что угодно другое не роняет проверку', () => {
  for (const value of [null, undefined, 'session not found', 404, {}, new Error('boom'), []]) {
    assert.equal(saysSessionMissing(value), false, String(value))
  }
})

test('строка отказа — одна на сервер и клиент', () => {
  // Ровно та, которую кладут маршруты в тело: разойдись они, клиент перестал
  // бы узнавать удалённую комнату и крутил бы «Reconnecting» вечно.
  assert.equal(SESSION_MISSING, 'session not found')
})
