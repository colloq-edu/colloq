/**
 * Чем засевается пустой лист консилиума.
 *
 * Лист сеяли общим текстом ячейки «на момент открытия». После «Показать классу»
 * общий текст — уже чьё-то решение: студент, подключившийся или перезагрузивший
 * страницу без попытки, получал его стартовым текстом СВОЕГО листа и одним
 * нажатием сдавал как своё, попадая в группу автора. Утечки в этом нет — текст
 * и так на экране, — но задания у него в листе не оставалось, а «попытка»
 * появлялась.
 *
 * Порядок теперь такой: своя попытка → задание (`CouncilMine.seed`, текст
 * ячейки на момент перевода замка в консилиум) → общий текст, если сервер
 * задания не прислал. Компилятора Svelte здесь нет: `$state` — подделка, как в
 * tests/council-client.test.mts.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CouncilMine } from '../shared/protocol.js'

const shim = <T,>(value: T): T => value
shim.raw = <T,>(value: T): T => value
;(globalThis as { $state?: unknown }).$state = shim
;(globalThis as { $derived?: unknown }).$derived = shim

const { sheetSeed } = await import('../web/src/lib/council.svelte.js')

/** То же выражение, что стоит в CellView при заведении листа. */
function seedForSheet(mine: Partial<CouncilMine> | null, shared: string): string {
  return sheetSeed(mine?.text, mine?.seed ?? shared)
}

const TASK = '# Посчитайте среднее по группам\ndf = pd.read_csv("marks.csv")'
const SHOWN = 'df.groupby("group")["mark"].mean()'

test('опоздавший получает задание, а не показанное решение', () => {
  assert.equal(seedForSheet({ text: '', seed: TASK }, SHOWN), TASK)
})

test('своя попытка старше задания', () => {
  assert.equal(seedForSheet({ text: 'моё', seed: TASK }, SHOWN), 'моё')
})

test('без задания от сервера сеем как раньше — общим текстом', () => {
  // Старый сервер поля не шлёт; поведение обязано остаться прежним.
  assert.equal(seedForSheet({ text: '' }, TASK), TASK)
  assert.equal(seedForSheet(null, TASK), TASK)
})

test('пустое задание — пустой лист, а не показанное решение', () => {
  /*
   * Замок перевели в консилиум на пустой ячейке — «напишите сами». Задание
   * пустое, и это ЗНАНИЕ, а не незнание: подставлять сюда общий текст нельзя,
   * потому что после «Показать классу» там лежит чужое решение.
   */
  assert.equal(seedForSheet({ text: '', seed: '' }, SHOWN), '')
})

test('отсутствующее поле и пустое поле — разные вещи', () => {
  // `??` смотрит на наличие поля, а не на его истинность: старый сервер поля не
  // шлёт и получает прежнее поведение, новый может прислать пустое задание.
  const fromOldServer: Partial<CouncilMine> = { text: '' }
  const emptyTask: Partial<CouncilMine> = { text: '', seed: '' }
  assert.equal(seedForSheet(fromOldServer, SHOWN), SHOWN)
  assert.equal(seedForSheet(emptyTask, SHOWN), '')
})
