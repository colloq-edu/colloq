/**
 * Отказы про терминал говорят на языке комнаты — вторая половина ящика.
 *
 * Расшифровку сторожит terminal-language: строки, которые печатает
 * `kernel/terminal.ts`, теперь русские. Но поверх той же расшифровки всплывают
 * тосты и отказы, и печатает их другой файл — `control.ts`: «That command is
 * over 4,096 characters», «Only the host can clear the terminal» стояли рядом с
 * русским «В этом семинаре запускает преподаватель», под русскими вкладками
 * «Терминал / Журнал ядра / История» и кнопками «Очистить» и «Завести оболочку
 * заново» (аудит · panels-15).
 *
 * Тип этого не видит, а половинчатость возвращается одной строкой, поэтому
 * условие здесь механическое: в дверях терминала (`case 'term:*'`) каждая
 * ФРАЗА — строка кода из нескольких слов — обязана быть на языке комнаты.
 * Односложные литералы (`'host'`, `'utf8'`, имена сообщений) не фразы и не
 * считаются; комментарии сняты — они не то, что читает класс.
 *
 * Кнопки при этом зовутся своими подписями: команду останавливает Ctrl+C
 * (кнопки «Стоп» в ящике нет), расшифровку чистит «Очистить». Обещание кнопки,
 * которой нет, — та же находка с другой стороны, и это проверяется тем же
 * условием, что в terminal-language.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const CONTROL = 'server/src/control.ts'
const DRAWER = 'web/src/components/panels/TerminalDrawer.svelte'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/**
 * Двери терминала: от первой из них до конца разбора сообщений.
 *
 * Двери стоят последними в `dispatch`, так что конец региона — первая функция
 * за ним. Считать скобки надёжности не добавит, а новая, седьмая дверь попадёт
 * сюда сама.
 */
function terminalDoors(): string {
  const code = read(CONTROL)
  const from = code.indexOf("case 'term:open'")
  assert.notEqual(from, -1, 'дверей терминала в control.ts не нашлось')
  const to = code.indexOf('\nfunction ', from)
  assert.notEqual(to, -1, 'за разбором сообщений не нашлось ни одной функции')
  return code.slice(from, to)
}

/** Строки кода без комментариев: комментарии класс не читает. */
function phrases(code: string): string[] {
  const bare = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
  const found = bare.match(/'[^'\n]*'|`[^`]*`/g) ?? []
  // Фраза — это несколько слов. `'host'`, `'utf8'`, `'term:run'` — не фразы, а
  // имена, и переводить их некому.
  return found.filter((text) => text.slice(1, -1).trim().includes(' '))
}

test('в отказах про терминал не осталось английских фраз', () => {
  const found = phrases(terminalDoors())
  assert.ok(found.length >= 6, `фраз в дверях терминала нашлось ${found.length} — разбор сломался`)
  for (const phrase of found) {
    assert.match(
      phrase,
      /[А-Яа-яЁё]/,
      `фраза из дверей терминала уехала бы в комнату по-английски: ${phrase}`,
    )
  }
})

test('отказ зовёт кнопки теми подписями, которые в ящике есть', () => {
  const found = phrases(terminalDoors()).join('\n')
  const drawer = read(DRAWER)
  // Кнопка «Очистить» в ящике есть, кнопки «Стоп» нет: команду останавливает
  // Ctrl+C. Обещать несуществующую кнопку в отказе — та же половинчатость.
  assert.match(drawer, />\s*Очистить\s*</, 'кнопку «Очистить» переименовали — поправьте отказы')
  assert.doesNotMatch(found, /«Стоп»/, 'отказ зовёт кнопку, которой в ящике нет')
  assert.doesNotMatch(found, /Press Stop|with Clear/)
})
