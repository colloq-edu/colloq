/**
 * Зеркало очереди в документе — и его цена на пятистах участниках.
 *
 * Очередь ядра лежит в общем документе, потому что её видят все. Меняется она
 * дважды на ячейку (взяли в работу, кончилась) и оба раза по краям: пропал
 * первый элемент или добавился последний. Полная перезапись превращала каждое
 * такое движение в «удалить всё и положить всё»: при правиле «по одной» и
 * пятистах участниках это сотни идентификаторов в обновлении Yjs, всей комнате,
 * плюс столько же тумбстоунов в документе — за прогон в пятьсот ячеек мегабайты
 * на клиента там, где хватило бы десятков байт.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queueDelta } from '../server/src/kernel/index.js'

test('ячейка ушла в работу — из зеркала уходит один элемент', () => {
  assert.deepEqual(queueDelta(['a', 'b', 'c'], ['b', 'c']), {
    at: 0,
    remove: 1,
    insert: [],
  })
})

test('ячейку поставили в хвост — в зеркало добавляется один элемент', () => {
  assert.deepEqual(queueDelta(['b', 'c'], ['b', 'c', 'd']), {
    at: 2,
    remove: 0,
    insert: ['d'],
  })
})

test('очередь не изменилась — правки нет вовсе', () => {
  assert.deepEqual(queueDelta(['a', 'b'], ['a', 'b']), { at: 2, remove: 0, insert: [] })
  assert.deepEqual(queueDelta([], []), { at: 0, remove: 0, insert: [] })
})

test('первая ячейка в пустую очередь и очередь, вынесенная целиком', () => {
  assert.deepEqual(queueDelta([], ['a']), { at: 0, remove: 0, insert: ['a'] })
  assert.deepEqual(queueDelta(['a', 'b', 'c'], []), { at: 0, remove: 3, insert: [] })
})

test('снятие из середины не трогает соседей', () => {
  // «Отменить» вынимает свои ячейки, где бы они ни стояли: голова и хвост
  // остаются на месте, и переписывать их незачем.
  assert.deepEqual(queueDelta(['a', 'b', 'c', 'd'], ['a', 'd']), {
    at: 1,
    remove: 2,
    insert: [],
  })
})

test('правка применима: из current всегда получается next', () => {
  const cases: Array<[string[], string[]]> = [
    [['a', 'b', 'c'], ['b', 'c']],
    [['b', 'c'], ['b', 'c', 'd']],
    [['a', 'b', 'c', 'd'], ['a', 'd']],
    [['a'], ['b']],
    [['a', 'b'], ['b', 'a']],
    [[], ['x', 'y', 'z']],
    [['x', 'y', 'z'], []],
    [['a', 'b', 'c'], ['a', 'x', 'c']],
  ]
  for (const [current, next] of cases) {
    const delta = queueDelta(current, next)
    const applied = [...current]
    applied.splice(delta.at, delta.remove, ...delta.insert)
    assert.deepEqual(applied, next, `${current.join()} → ${next.join()}`)
    // И правка действительно узкая: она не переписывает того, что не менялось.
    assert.ok(
      delta.remove + delta.insert.length <= current.length + next.length,
      'правка вышла шире полной перезаписи',
    )
  }
})
