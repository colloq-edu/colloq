/**
 * Поле потолка оракула — единственная ручка правил, где значение НАБИРАЮТ.
 *
 * Всё остальное в списке — переключатели: нажали, и правило либо доехало, либо
 * нет. У числа два лишних состояния, и оба тихие: браузер отдаёт неразбираемый
 * ввод («5e») пустой строкой — то есть «как на инстансе», — а неудачное
 * сохранение оставляет в поле число, которого в комнате нет. Ни то, ни другое
 * не видно глазами: поле выглядит одинаково правильным.
 *
 * Читается прямо из компонента, как в `panels-craft`: у разметки на рунах нет
 * ни чистой функции, ни браузера, а тест со своей копией правила проходит
 * вечно, пока файл уезжает. Поэтому здесь проверяется ПОРЯДОК — что стоит
 * раньше чего, — а не пересказ поведения.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const RULES = 'web/src/components/RoomRulesRows.svelte'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Код без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const source = code(read(RULES))
const commit = source.slice(source.indexOf('function commit('), source.indexOf('</script>'))
const effect = source.slice(source.indexOf('$effect(() => {'), source.indexOf('function commit('))

test('мусор в числовом поле не читается как «как на инстансе»', () => {
  const bad = commit.indexOf('field.validity.badInput')
  const empty = commit.indexOf('if (!text)')
  assert.ok(bad > 0, 'badInput вообще проверяется')
  assert.ok(bad < empty, 'и проверяется ДО ветки «пусто → null» — иначе «5e» снимает потолок')

  const guard = commit.slice(bad, empty)
  assert.match(guard, /field\.value = current === null \? '' : String\(current\)/)
  assert.doesNotMatch(guard, /onchange/, 'мусор ничего не сохраняет')
})

test('клампинг виден до ответа сервера: число ложится в поле раньше запроса', () => {
  const tail = commit.slice(commit.indexOf('const value = Math.min'))
  const put = tail.indexOf('field.value = String(value)')
  const send = tail.indexOf('onchange(')
  assert.ok(put > 0, 'клампленное число ставится в поле')
  assert.ok(put < send, '«500» → «200» видно сразу, а не через круг до сервера')
})

test('поле возвращается к сохранённому только когда сохранение ОТВЕТИЛО', () => {
  // Вызывающий (`setRule` в SessionScreen и в admin/Seminars) поднимает busy
  // синхронно, ещё до запроса: эффект, срабатывающий на любое изменение busy,
  // застаёт на подъёме прежние `rules` и стирает только что набранное число.
  assert.doesNotMatch(effect, /void busy/, 'эффект не будится подъёмом busy')
  assert.match(effect, /const answered = saving && !busy/, 'сверка — на спаде busy')
  assert.match(effect, /saving = busy/, 'и спад запоминается для следующего кадра')

  const guard = effect.indexOf('if (!answered) return')
  const write = effect.indexOf('field.value = want')
  assert.ok(guard > 0, 'без ответа эффект выходит')
  assert.ok(guard < write, 'запись в поле недостижима, пока сохранение в пути')
})

test('оба вызывающих поднимают busy до запроса — на этом стоит спад', () => {
  for (const rel of ['web/src/screens/SessionScreen.svelte', 'web/src/admin/screens/Seminars.svelte']) {
    const set = code(read(rel))
    const fn = set.slice(set.indexOf('async function setRule('))
    const raise = fn.indexOf('rulesBusy = true')
    const request = fn.indexOf('await ')
    const drop = fn.indexOf('rulesBusy = false')
    assert.ok(raise >= 0 && request > raise, `${rel}: busy поднят до запроса`)
    assert.ok(drop > request, `${rel}: и снят после ответа — и на успехе, и на отказе`)
  }
})
