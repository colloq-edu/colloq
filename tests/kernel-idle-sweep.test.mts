/**
 * Уборка простоя и остановленные контейнеры.
 *
 * Она спрашивала `docker ps` без `-a`, то есть видела только живые контейнеры.
 * Остановленный (а после перезагрузки машины при `--restart=no` такими
 * становятся ВСЕ вчерашние) для неё не существовал вовсе — и не убирался
 * никогда, ни через два часа, ни через неделю: только руками или при новом
 * открытии той же комнаты. На машине с GPU это значит, что срезы держат
 * комнаты, которых больше никто не откроет, и новый семинар слышит «свободных
 * срезов нет: их два, и все заняты другими семинарами».
 *
 * Правило вынесено отдельно от докера, потому что ошибка была именно в нём.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idleVerdict } from '../server/src/kernel/index.js'

const MINUTE = 60 * 1000
const now = 1_700_000_000_000

test('занятая комната не убирается никогда', () => {
  // Считающая ячейка, очередь, команда в оболочке или живые вкладки — всё это
  // работа с хозяином, и сносить контейнер под ней нельзя.
  assert.equal(idleVerdict({ running: true, busy: true, since: now - 300 * MINUTE, now }), 'busy')
  assert.equal(idleVerdict({ running: false, busy: true, since: now - 300 * MINUTE, now }), 'busy')
})

test('пустую комнату сначала берут на заметку, а не убирают', () => {
  // Первый взгляд — начало отсчёта, а не приговор: иначе перезапуск сервера
  // сносил бы контейнеры всех идущих пар разом.
  assert.equal(idleVerdict({ running: true, busy: false, since: undefined, now }), 'watch')
  assert.equal(idleVerdict({ running: false, busy: false, since: undefined, now }), 'watch')
})

test('живой контейнер держится два часа — пара плюс кофе', () => {
  assert.equal(idleVerdict({ running: true, busy: false, since: now - 90 * MINUTE, now }), 'watch')
  assert.equal(idleVerdict({ running: true, busy: false, since: now - 121 * MINUTE, now }), 'drop')
})

test('остановленный контейнер убирается — и раньше живого', () => {
  // Терять там нечего: его Python убит вместе с ним, а держит он слой на диске
  // и срез GPU. Два часа ожидания — это целое утро без карты.
  assert.equal(idleVerdict({ running: false, busy: false, since: now - 10 * MINUTE, now }), 'watch')
  assert.equal(idleVerdict({ running: false, busy: false, since: now - 31 * MINUTE, now }), 'drop')
  // И главное: он вообще попадает под приговор, а не живёт вечно.
  assert.equal(
    idleVerdict({ running: false, busy: false, since: now - 24 * 60 * MINUTE, now }),
    'drop',
  )
})
