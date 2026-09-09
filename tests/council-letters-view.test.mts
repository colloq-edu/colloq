/**
 * Два письма преподавателя читаются как два — на листе студента.
 *
 * Сервер держит письма порознь: личное и рассылку группе, каждое в своей
 * ячейке (server/src/council.ts · keeping). Наружу они едут дважды — списком
 * `replies` и склейкой в `reply` для клиентов, которые про список ещё не
 * знают. Клиент, который знает и всё равно рисует склейку, показывает
 * «Проверьте знак Всем: поправка» одной строкой: переносы в этой вёрстке
 * схлопываются, и личный ответ пропадает внутри рассылки.
 *
 * Проверяется не «красиво», а три вещи:
 *  — правило одно и живёт в shared (councilLetters), включая запасной путь:
 *    у старого сервера поля `replies` нет вовсе, и без него студент не увидел
 *    бы ответа вообще;
 *  — обе поверхности — лист студента и стопка преподавателя — рисуют по
 *    строке на письмо, а не одно поле;
 *  — рассылка помечена словом — тогда молчание на соседней строке значит
 *    «это вам лично», а не «мы не знаем, кому».
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { councilLetters, type CouncilReply } from '../shared/protocol.js'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')

/** Разметка без комментариев: объяснение — не обещание. */
const code = (source: string): string =>
  source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

const CELL = code(read('web/src/components/notebook/CellView.svelte'))
const STACK = code(read('web/src/components/council/CouncilStack.svelte'))

const letter = (text: string, to?: 'person' | 'group'): CouncilReply => ({
  text,
  at: 1_757_000_000_000,
  by: 'Пётр Ильич',
  ...(to ? { to } : {}),
})

test('письма берутся списком, а склейка — только когда списка нет', () => {
  const person = letter('Проверьте знак', 'person')
  const group = letter('Всем: поправка', 'group')
  const glued = letter('Проверьте знак\n\nВсем: поправка', 'group')

  assert.deepEqual(
    councilLetters({ reply: glued, replies: [person, group] }),
    [person, group],
    'список есть, а прочитана склейка — два письма снова читаются одним',
  )
  // Старый сервер: поля `replies` нет вовсе, и единственное, что приехало, —
  // склейка. Без запасного пути студент не увидел бы ответа совсем.
  assert.deepEqual(councilLetters({ reply: glued }), [glued], 'запасной путь через reply потерян')
  assert.deepEqual(councilLetters({ reply: null }), [], 'писем нет — рисовать нечего')
  assert.deepEqual(councilLetters({ reply: null, replies: [] }), [])
  assert.deepEqual(councilLetters(null), [])
  assert.deepEqual(councilLetters(undefined), [])
})

test('лист студента рисует по строке на письмо и помечает рассылку', () => {
  assert.match(
    CELL,
    /import \{[^}]*\bcouncilLetters\b[^}]*\} from '@shared\/protocol'/,
    'лист завёл свою копию правила вместо общей (shared/protocol · councilLetters)',
  )
  assert.match(
    CELL,
    /const letters = \$derived\(councilLetters\(mine\)\)/,
    'письма листа считаются не общей функцией',
  )

  const start = CELL.indexOf('{#each letters as letter}')
  assert.notEqual(start, -1, 'письма рисуются одной строкой, а не перебором')
  const block = CELL.slice(start, CELL.indexOf('{/each}', start))
  for (const field of ['letter.by', 'clock(letter.at)', 'letter.text']) {
    assert.ok(block.includes(field), `в строке письма нет ${field} — письмо без подписи или без времени`)
  }
  assert.match(
    block,
    /letter\.to === 'group'/,
    'рассылка группе ничем не помечена — личный ответ и письмо всем читаются одинаково',
  )
  assert.ok(block.includes("tr('room.ui.70')"), 'у пометки рассылки нет перевода')

  // Обратная сторона: пока склейка где-то рисуется, дефект жив ровно там.
  assert.doesNotMatch(
    CELL,
    /mine\??\.reply\b/,
    'лист снова рисует склейку `reply` — два письма прочтутся одним',
  )
})

test('стопка преподавателя читает те же письма той же функцией', () => {
  /*
   * Вторая поверхность — карточка попытки на пульте. Правило здесь то же
   * самое, и берётся оно оттуда же: своя копия «списка, а если его нет —
   * склейки» разошлась бы с листом на первой же правке.
   */
  assert.match(
    STACK,
    /import \{[^}]*\bcouncilLetters\b[^}]*\} from '@shared\/protocol'/,
    'стопка завела свою копию правила вместо общей',
  )
  const start = STACK.indexOf('{#each councilLetters(attempt)')
  assert.notEqual(start, -1, 'карточка рисует письма одной строкой, а не перебором')
  const block = STACK.slice(start, STACK.indexOf('{/each}', start))
  for (const field of ['letter.by', 'clock(letter.at)', 'letter.text']) {
    assert.ok(block.includes(field), `в строке письма нет ${field}`)
  }
  assert.match(block, /letter\.to === 'group'/, 'рассылка группе ничем не помечена')
  assert.ok(block.includes("tr('room.ui.70')"), 'у пометки рассылки нет перевода')
  assert.doesNotMatch(
    STACK,
    /attempt\??\.reply\b/,
    'карточка снова рисует склейку `reply` — два письма прочтутся одним',
  )
})
