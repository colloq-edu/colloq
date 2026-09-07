/**
 * Слот сборки: кто занят, пока идёт цепочка.
 *
 * Наследование окружений значит, что нажатие Build на `gpu` собирает и
 * `base-gpu` под ним. Шапка `startBuild` обещает: «пока идёт цепочка, „Building“
 * стоит на каждом её звене, и второй Build на родителя посреди этой сборки не
 * начнётся». Обещание держалось наполовину: слот занимался синхронно только для
 * самого имени, а родители регистрировались после `docker compose ps` и опроса
 * образов — сотни миллисекунд, за которые второе окно панели успевало запустить
 * свой `docker build` с тем же `-t`. Дальше запись родителя подменялась записью
 * ребёнка (лог и Cancel родителя пропадали), а конец цепочки её удалял, пока
 * собственная сборка родителя ещё шла.
 *
 * Здесь проверяется ровно то окно: между вызовом `startBuild` и первым `await`
 * внутри него. Docker для этого не нужен — сборка отменяется до него.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChain,
  buildLog,
  cancelBuild,
  isBuilding,
  startBuild,
} from '../server/src/environments.js'

test('цепочка занимается вся и сразу — второй Build на родителя не начнётся', async () => {
  // Образцовая цепочка репозитория; если она разъедется, тест должен сказать об
  // этом словами, а не молча проверять что-то другое.
  assert.deepEqual(buildChain('gpu'), ['base-gpu', 'gpu'])
  assert.equal(isBuilding('base-gpu'), false, 'кто-то уже собирает базу до начала теста')

  const first = startBuild('gpu')
  /*
   * Ни одного `await` между стартом и этими строками — это и есть окно. Раньше
   * здесь было `false`, и следующий Build запускал вторую сборку.
   *
   * Снимок берётся до `cancelBuild`, а утверждения — после: отмена обязана
   * случиться в этом же тике, иначе упавшее утверждение оставит на машине
   * настоящий `docker build` на десять минут.
   */
  const busyChild = isBuilding('gpu')
  const busyParent = isBuilding('base-gpu')
  const second = startBuild('base-gpu')
  const log = buildLog('base-gpu')
  const seen = { done: log?.done, failed: log?.failed, lines: log?.lines.join(' / ') ?? '' }
  cancelBuild('gpu')

  assert.equal(busyChild, true)
  assert.equal(busyParent, true, 'родитель свободен, пока цепочка на него уже идёт')
  assert.ok(log, 'у родителя нет журнала — значит, он не принадлежит идущей цепочке')
  assert.equal(seen.done, false)
  assert.equal(seen.failed, false, `второй Build на родителя что-то завёл: ${seen.lines}`)

  await Promise.all([first, second])

  // И отпустила: «Building» на звене, которое никто не собирает, — запертая
  // кнопка и враньё в строке.
  assert.equal(isBuilding('base-gpu'), false, 'родитель остался занят после конца цепочки')
  assert.equal(isBuilding('gpu'), false)
})

test('Build на звене чужой живой цепочки отказывает словами, а не молча', async () => {
  const first = startBuild('gpu')
  const second = startBuild('base-gpu')
  const said = buildLog('base-gpu')?.lines.join('\n') ?? ''
  cancelBuild('gpu')
  // Журнал родителя — журнал ПЕРВОЙ сборки, и второй в него ничего не написал:
  // отказ адресован тому, кто нажал, а не тому, кто уже собирается.
  assert.equal(/уже собирается/.test(said), false)
  await Promise.all([first, second])

  // А вот наоборот — цепочка поверх занятого родителя — отказывает вслух.
  const parent = startBuild('base-gpu')
  const child = startBuild('gpu')
  const childLog = buildLog('gpu')
  const childSaid = childLog?.lines.join('\n') ?? ''
  const childFailed = childLog?.failed
  cancelBuild('base-gpu')

  assert.ok(childLog)
  assert.match(
    childSaid,
    /«base-gpu».*уже собирается/,
    'ребёнок начал собираться поверх слоя, который в этот момент пересобирают',
  )
  assert.equal(childFailed, true)
  await Promise.all([parent, child])
})
