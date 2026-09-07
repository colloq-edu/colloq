/**
 * Потолки вывода попытки: где кончается «поместилось» и начинается «срезано».
 *
 * Карточка попытки едет хосту вместе со всей стопкой, поэтому потолок здесь
 * ниже, чем у ячейки, — и тем важнее, чтобы он срабатывал ровно там, где надо.
 * Сравнение стояло нестрогое (`>=`), и текст, уложившийся в бюджет до символа,
 * объявлялся обрезанным: под ним появлялось «остановлен после 64 КБ — пишите в
 * файл», а всё, что попытка печатала дальше (обычно как раз ответ последней
 * строкой), молча выбрасывалось.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CouncilOutputBuffer,
  MAX_ATTEMPT_OUTPUT_CHARS,
} from '../server/src/kernel/council.js'

const truncationNotice = (outputs: ReturnType<CouncilOutputBuffer['snapshot']>) =>
  outputs.find((o) => o.kind === 'stream' && /остановлен после/.test(o.text))

test('текст ровно в бюджет проходит целиком и без предупреждения', () => {
  const buffer = new CouncilOutputBuffer()
  buffer.stream('stdout', 'a'.repeat(MAX_ATTEMPT_OUTPUT_CHARS))
  const outputs = buffer.snapshot()

  assert.equal(outputs.length, 1, `записей ${outputs.length}: ${JSON.stringify(outputs)}`)
  assert.ok(outputs[0].kind === 'stream')
  assert.equal(outputs[0].text.length, MAX_ATTEMPT_OUTPUT_CHARS, 'текст срезали, хотя он поместился')
  assert.equal(truncationNotice(outputs), undefined, 'обрезки не было, а сказано, что была')
})

test('следующий символ за бюджетом — вот теперь обрезка, и она названа', () => {
  const buffer = new CouncilOutputBuffer()
  buffer.stream('stdout', 'a'.repeat(MAX_ATTEMPT_OUTPUT_CHARS))
  buffer.stream('stdout', 'итог: 42\n')
  const outputs = buffer.snapshot()

  assert.ok(truncationNotice(outputs), 'обрезали молча')
  const body = outputs.filter((o) => o.kind === 'stream' && !/остановлен после/.test(o.text))
  const total = body.reduce((sum, o) => sum + (o.kind === 'stream' ? o.text.length : 0), 0)
  assert.equal(total, MAX_ATTEMPT_OUTPUT_CHARS, 'за потолок утекло лишнее')
})

test('текст на символ длиннее бюджета срезается ровно по нему', () => {
  const buffer = new CouncilOutputBuffer()
  buffer.stream('stdout', 'a'.repeat(MAX_ATTEMPT_OUTPUT_CHARS + 1))
  const outputs = buffer.snapshot()

  assert.ok(truncationNotice(outputs), 'обрезка была, а предупреждения нет')
  assert.ok(outputs[0].kind === 'stream')
  assert.equal(outputs[0].text.length, MAX_ATTEMPT_OUTPUT_CHARS)
})

test('обычная попытка ничего не теряет', () => {
  const buffer = new CouncilOutputBuffer()
  buffer.stream('stdout', 'считаю\n')
  buffer.stream('stdout', 'готово\n')
  const outputs = buffer.snapshot()

  assert.equal(outputs.length, 1)
  assert.ok(outputs[0].kind === 'stream')
  assert.equal(outputs[0].text, 'считаю\nготово\n')
})
