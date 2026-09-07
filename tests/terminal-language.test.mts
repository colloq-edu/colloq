/**
 * Расшифровка терминала говорит на языке комнаты.
 *
 * Английской в ящике оставалась половина, которой нет в разметке: строки
 * печатает сервер (`server/src/kernel/terminal.ts`), а приезжают они в ту же
 * вкладку, где русские «Терминал / Журнал ядра / История», приглашение
 * «оболочка запускается…» и кнопки «Очистить» и «Завести оболочку заново».
 * «X pressed Ctrl+C.», «the shell exited — open the terminal again…» стояли
 * строкой ниже русского отказа — класс читал оба языка в одном столбце.
 *
 * Тип этого не видит, поэтому здесь два условия, которые легко нарушить
 * следующей правкой:
 *
 *  1. в строке расшифровки нет английской фразы;
 *  2. кнопка названа той подписью, которая в ящике действительно есть.
 *
 * Второе — не педантизм: прежняя строка звала «Press Stop», а кнопки «Стоп» в
 * ящике нет и не было (команду останавливает Ctrl+C), и «with Clear» — при
 * кнопке «Очистить». Обещание кнопки, которой нет, — та же находка, только с
 * другой стороны.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const TERMINAL = 'server/src/kernel/terminal.ts'
const DRAWER = 'web/src/components/panels/TerminalDrawer.svelte'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/**
 * Строки, которые видит комната: всё, помеченное `[colloq]`, фразы отказа
 * (`fail`) и та, что собирается для него в переменную, — вместе с их
 * продолжениями: длинная строка сложена из кусков через `+`, и второй кусок
 * такая же часть фразы, как первый.
 */
function notices(): string[] {
  // `systemLine(term, `[colloq] ${message}`)` — не фраза, а конверт: сама
  // фраза приходит сюда из `fail`, и проверяется там же, где написана.
  const envelope = /\[colloq\] \$\{[a-zA-Z.]+\}`\)/
  const opens = /\[colloq\]|fail\(term, ['`]|const message = `/
  const lines = read(TERMINAL).split('\n')
  const found: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!opens.test(lines[i]) || envelope.test(lines[i])) continue
    let text = lines[i]
    let j = i
    while (lines[j].trimEnd().endsWith('+') && j + 1 < lines.length) {
      j += 1
      text += ' ' + lines[j].trim()
    }
    found.push(text)
  }
  return found
}

test('в расшифровке терминала не осталось английских фраз', () => {
  const said = notices()
  assert.ok(said.length >= 15, `нашли всего ${said.length} строк расшифровки — разбор сломался`)
  for (const line of said) {
    assert.match(line, /[А-Яа-яЁё]/, `строка без единого русского слова: ${line.trim()}`)
    // Три латинских слова подряд — это фраза, а не `vim`, `Ctrl+C` или `HTTP`.
    assert.doesNotMatch(
      line,
      /[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/,
      `английская фраза в расшифровке: ${line.trim()}`,
    )
  }
})

test('кнопку в расшифровке зовут её подписью из ящика', () => {
  const drawer = read(DRAWER)
  const named = new Set<string>()
  for (const line of notices()) {
    for (const found of line.matchAll(/«([^»]+)»/g)) named.add(found[1])
  }
  assert.ok(named.size > 0, 'расшифровка не называет ни одной кнопки — проверять нечего')
  for (const label of named) {
    assert.ok(
      drawer.includes(label),
      `расшифровка обещает кнопку «${label}», а в ящике такой подписи нет`,
    )
  }
})

test('полноэкранную программу останавливают тем, чем её и правда останавливают', () => {
  // Кнопки «Стоп» у терминала нет: единственный способ прервать команду —
  // Ctrl+C, и подсказка строки ввода говорит ровно это («ctrl-c остановит»).
  const screen = notices().find((line) => line.includes('vim'))
  assert.ok(screen, 'строка про полноэкранную программу пропала')
  assert.match(screen, /Ctrl\+C/, 'комнате не сказали, чем остановить такую программу')
  assert.match(read(DRAWER), /ctrl-c остановит/, 'подсказка ящика разошлась с расшифровкой')
})
