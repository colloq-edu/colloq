/**
 * Панель истории договаривает про обрезанное начало.
 *
 * Сервер считает признак и везёт его в ответе ленты
 * (`history-trimmed-route.test.mts`), но пока панель его не рисует, обрезка
 * остаётся ровно такой же молчаливой: список начинается с середины пары и
 * выглядит как вся история короткой. Смотрят же историю обычно тогда, когда
 * что-то потеряли, — и «раньше ничего не было» здесь читается как ответ.
 *
 * Проверяются три вещи, каждая из которых по отдельности сводит признак на нет:
 * форма ответа в `lib/history` (своя копия `{ versions }` молча отрезала поле
 * на полпути), чтение поля в состояние панели и место строки — ПОСЛЕ списка.
 * Лента идёт от свежего к старому, так что граница сохранившегося проходит под
 * последней строкой; сказанное сверху указывало бы на свежие правки.
 *
 * И отдельно — слова. Окно ленты (`MAX_VERSIONS`) тоже отдаёт не всё, но те
 * версии в базе есть и открываются по ссылке. Строка говорит про удалённые:
 * «не хранятся», а не «не показаны».
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const TAB = code(read('web/src/components/panels/HistoryTab.svelte'))
const LIB = code(read('web/src/lib/history.ts'))
const SHARED = read('shared/history.ts')

test('форма ответа ленты названа один раз — в shared', () => {
  assert.match(SHARED, /export interface VersionList \{[\s\S]*?trimmed: boolean/, 'shared/history.ts')
  assert.match(LIB, /listVersions\([\s\S]*?\): Promise<VersionList>/, 'браузер берёт форму оттуда же')
  assert.doesNotMatch(
    LIB,
    /Promise<\{ versions: Version\[\] \}>/,
    'своя копия формы снова отрезала бы trimmed по дороге к панели',
  )
})

test('панель читает признак обрезки из ответа', () => {
  assert.match(TAB, /let trimmed = \$state\(false\)/, 'признака нет в состоянии')
  assert.match(TAB, /trimmed = body\.trimmed/, 'ответ прочитан, а поле выброшено')
})

test('строка про несохранившееся начало стоит в конце ленты и только при обрезке', () => {
  const tail = TAB.slice(TAB.indexOf('{#each versions as v'))
  const each = tail.indexOf('{/each}')
  const note = tail.indexOf('Более ранние версии не хранятся')
  assert.ok(each >= 0, 'список версий не найден — тест смотрит не туда')
  assert.ok(note > each, 'приписка стоит не под самой старой строкой списка')
  assert.match(
    tail.slice(each, note),
    /\{#if trimmed\}/,
    'приписка не под условием: целой ленте она соврёт',
  )
  // Про удалённое, а не про окно ленты: вытесненные MAX_VERSIONS версии в базе
  // есть, и говорить о них надо другими словами.
  assert.match(TAB, /история комнаты ограничена по объёму/)
  assert.doesNotMatch(tail.slice(note, tail.indexOf('</p>', note)), /не показаны|показаны не все/)
})
