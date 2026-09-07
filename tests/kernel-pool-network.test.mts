/**
 * «Та ли это сеть» — вопрос, ценой ответа на который идут переменные семинара.
 *
 * Контейнер комнаты переживает перезапуск сервера намеренно: `make run` после
 * правки не должен стоить занятию состояния. Единственное, что стоит на этом
 * пути, — сравнение режима сети: не сошлось, значит до контейнера нет дороги,
 * значит сносим и поднимаем пустой. Сравнение было со словом `default`, и на
 * docker 24+ (`bridge`) оно не сходилось НИКОГДА — то есть каждый первый Run
 * после перезапуска молча уносил всё, что комната успела посчитать.
 *
 * Настоящего docker в сюите нет (см. `_env.mts`), поэтому проверяется чистое
 * правило — та самая строка, в которой всё и было.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { networkMatches } from '../server/src/kernel/pool.js'

test('в хостовом режиме контейнер без --network считается своим', () => {
  // Docker 20 и его `default`, docker 24+ и его `bridge` — одно и то же
  // положение дел: контейнер поднят без `--network`, порт опубликован на петле.
  assert.equal(networkMatches('default', ''), true)
  assert.equal(networkMatches('bridge', ''), true)
  assert.equal(networkMatches('  bridge  ', ''), true)
})

test('в хостовом режиме контейнер из сети compose своим не считается', () => {
  // До него нет дороги: порт не опубликован, а по имени контейнера с хоста не
  // ходят. Такой пересоздать — правильно.
  assert.equal(networkMatches('colloq', ''), false)
  assert.equal(networkMatches('host', ''), false)
})

test('в сетевом режиме сходится только названная сеть', () => {
  assert.equal(networkMatches('colloq', 'colloq'), true)
  assert.equal(networkMatches('bridge', 'colloq'), false)
  assert.equal(networkMatches('default', 'colloq'), false)
})
