/**
 * Возвращение пятисот вкладок после обрыва — самое дорогое, что делает клиент.
 *
 * Связь роняет не вкладка, а провод: перезапуск сервера, упавший Wi-Fi в
 * аудитории, ретранслятор. Дальше всё зависит от двух строк. Отступ без
 * разброса — и пятьсот вкладок отсчитывают один и тот же интервал от одного и
 * того же события: сервер поднимается, получает пятьсот рукопожатий в одну
 * миллисекунду, часть не успевает, эти отступают снова и снова приходят вместе.
 * Второй запрос за деревом файлов на входе — и к пятистам рукопожатиям
 * добавляются пятьсот обходов папки по HTTP за тем же списком, который
 * управляющий сокет присылает сам.
 *
 * Проверяется то, что можно проверить без браузера: сама лестница отступа —
 * функцией, а обещание «спрашиваем дерево один раз» — по исходнику, потому что
 * живёт оно в рунном классе.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COLLAB_BACKOFF_MIN_MS,
  COLLAB_BACKOFF_SPREAD_MS,
  collabBackoff,
  reconnectDelay,
  RECONNECT_MAX_MS,
} from '../web/src/lib/controls.js'

/* ---------------------------------------------------------------- отступ */

test('отступ растёт вдвое и упирается в прежний потолок', () => {
  // Верхняя граница не выросла: разброс отнимает у отступа, а не добавляет.
  assert.equal(reconnectDelay(0, 1), 500)
  assert.equal(reconnectDelay(1, 1), 1000)
  assert.equal(reconnectDelay(5, 1), RECONNECT_MAX_MS)
  assert.equal(reconnectDelay(50, 1), RECONNECT_MAX_MS, 'лестница кончается, ожидание — нет')
})

test('две вкладки не возвращаются в одну миллисекунду', () => {
  // Ровно то, ради чего разброс: одинаковый номер попытки — разное время.
  assert.notEqual(reconnectDelay(3, 0.1), reconnectDelay(3, 0.9))
  // Половина отступа случайна, и обе половины ограничены: никто не ждёт ни
  // дольше потолка, ни меньше половины своей ступени.
  for (const retries of [0, 1, 2, 3, 4, 5, 9]) {
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = reconnectDelay(retries, random)
      const step = Math.min(500 * 2 ** Math.min(retries, 5), RECONNECT_MAX_MS)
      assert.ok(delay >= step / 2, `${retries}/${random}: слишком рано`)
      assert.ok(delay <= step, `${retries}/${random}: дольше своей ступени`)
      assert.ok(delay <= RECONNECT_MAX_MS)
    }
  }
})

/* ------------------------------------------------- один вопрос про дерево */

/** Код без объяснений: комментарий — не обещание, а рассказ о прошлом. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const SESSION = code(
  fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'web/src/lib/session.svelte.ts'),
    'utf8',
  ),
)

test('своей лестницы отступа у комнаты не осталось', () => {
  assert.match(SESSION, /const delay = reconnectDelay\(this\.#retries\)/)
  assert.doesNotMatch(SESSION, /Math\.min\(500 \* 2 \*\*/, 'вторая копия лестницы разошлась бы')
})

test('дерево файлов вкладка спрашивает один раз — и не по HTTP', () => {
  /*
   * Список приезжает приветственной пачкой управляющего сокета (control.ts),
   * причём из кэша комнаты. HTTP-запрос за тем же деревом в конструкторе
   * удваивал обход папки на каждую вкладку — на пятистах это секунды
   * блокировки цикла событий ровно тогда, когда все ждут возврата.
   */
  assert.doesNotMatch(SESSION, /refreshFiles/)
  assert.doesNotMatch(SESSION, /api\.listFiles/)
  // А кадр `files` по сокету по-прежнему разбирается — иначе панель осталась бы
  // без дерева вовсе.
  assert.match(SESSION, /message\.t === 'files'/)
  assert.match(SESSION, /this\.filesArrived = true/)
})

/* --------------------------------------------- отступ общего документа */

test('у общего документа потолок отступа свой у каждой вкладки', () => {
  /*
   * Лестница y-websocket — `min(2^n · 100 мс, maxBackoffTime)`, и потолок по
   * умолчанию ОДИН И ТОТ ЖЕ у всех (2500 мс). То есть с шестой попытки пятьсот
   * вкладок стучатся ровно каждые две с половиной секунды, все вместе, от
   * одного и того же события. Разброса в самой лестнице провайдер не умеет, а
   * потолок читает у себя на каждой попытке — случайным он и растаскивает пачку.
   */
  assert.equal(collabBackoff(0), COLLAB_BACKOFF_MIN_MS)
  assert.equal(collabBackoff(1), COLLAB_BACKOFF_MIN_MS + COLLAB_BACKOFF_SPREAD_MS)
  assert.notEqual(collabBackoff(0.1), collabBackoff(0.9))
  // Ждать дольше — цена, и она ограничена с обеих сторон: не раньше прежних
  // двух с половиной секунд и не дольше десяти.
  for (const random of [0, 0.2, 0.5, 0.8, 1]) {
    const wait = collabBackoff(random)
    assert.ok(wait >= 2500, `${random}: возвращаются раньше прежнего`)
    assert.ok(wait <= COLLAB_BACKOFF_MIN_MS + COLLAB_BACKOFF_SPREAD_MS, `${random}: ждут слишком долго`)
  }
  // Шире окна, в которое сервер принимает пачку рукопожатий: иначе разброс
  // ничего не растаскивает.
  assert.ok(COLLAB_BACKOFF_SPREAD_MS >= 5000)
})

test('провайдер общего документа заводится с этим потолком, а не со своим', () => {
  assert.match(SESSION, /maxBackoffTime: collabBackoff\(\)/)
  // И вторая копия лестницы не заведена: правило одно и живёт в controls.ts.
  assert.doesNotMatch(SESSION, /maxBackoffTime: \d/, 'потолок прибит числом — он снова общий')
})
