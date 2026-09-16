/**
 * CLI говорит по-английски, а объясняет себя по-русски.
 *
 * Два языка в одном файле — это не недоделка, а решение, и оно держится ровно
 * на границе кавычек. Строка — это ЭКРАН: её читает человек, поставивший
 * `pip install colloq` где угодно на свете. Комментарий — это ПРИЧИНА: его
 * читает тот, кто правит соседнюю строку через год, и написан он по-русски,
 * потому что по-русски в нём сказано больше.
 *
 * Граница ничем, кроме этой проверки, не держится: ни типами, ни сборкой. Стоит
 * кому-нибудь дописать отказ на родном языке — и у половины преподавателей
 * посреди английского экрана появится русская фраза. Ловим это здесь, а не на
 * паре.
 *
 * Комментарии из кода вырезаются не регуляркой. Регулярка спотыкается о самые
 * обычные вещи: `'https://colloq.ru'` внутри строки выглядит как начало
 * комментария, а `'/*'` в тексте — как начало блочного. Поэтому ниже — маленький
 * посимвольный разбор, который знает про три состояния (код, строка,
 * комментарий) и потому не ошибается ни на том, ни на другом.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const CYRILLIC = /[А-Яа-яЁё]/

/** Каждый строковый литерал файла: три вида кавычек, комментарии — мимо. */
function literals(source: string): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = []
  let line = 1
  for (let at = 0; at < source.length; at++) {
    const ch = source[at]
    if (ch === '\n') {
      line++
      continue
    }
    if (ch === '/' && source[at + 1] === '/') {
      while (at < source.length && source[at] !== '\n') at++
      at--
      continue
    }
    if (ch === '/' && source[at + 1] === '*') {
      at += 2
      while (at < source.length && !(source[at] === '*' && source[at + 1] === '/')) {
        if (source[at] === '\n') line++
        at++
      }
      at++
      continue
    }
    if (ch !== "'" && ch !== '"' && ch !== '`') continue
    const quote = ch
    const at0 = at
    const line0 = line
    at++
    for (; at < source.length; at++) {
      if (source[at] === '\\') {
        at++
        continue
      }
      if (source[at] === '\n') {
        line++
        // Незакрытая одинарная или двойная кавычка — это не литерал, а,
        // например, апостроф внутри комментария, который мы уже пропустили бы.
        // У шаблонной перенос строки законен, и она продолжается.
        if (quote !== '`') break
        continue
      }
      if (source[at] === quote) break
    }
    found.push({ text: source.slice(at0, at + 1), line: line0 })
  }
  return found
}

function cliSources(): { name: string; source: string }[] {
  const dir = new URL('../cli/src/', import.meta.url)
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, source: readFileSync(new URL(name, dir), 'utf8') }))
}

test('CLI strings are English; only its comments are Russian', () => {
  const guilty: string[] = []
  for (const { name, source } of cliSources())
    for (const { text, line } of literals(source))
      if (CYRILLIC.test(text)) guilty.push(`cli/src/${name}:${line}  ${text.slice(0, 80)}`)
  assert.deepEqual(
    guilty,
    [],
    'русская строка на английском экране:\n' +
      guilty.join('\n') +
      '\n\nЭкран — по-английски, причина — комментарием по-русски.',
  )
})

/**
 * Проверка сама себе не верит на слово: разбор проверяется на образцах, где
 * регулярка ошибается. Иначе однажды он тихо перестанет находить что-либо
 * вовсе, и тест станет зелёным навсегда, ничего не проверяя.
 */
test('the scanner tells a string from a comment, including the tricky shapes', () => {
  const sample = [
    `const url = 'https://colloq.ru/// не комментарий'`,
    `// зато это комментарий: 'русская строка внутри него не в счёт'`,
    `/* и это тоже: "и здесь" */ const ok = "English"`,
    'const tpl = `и это строка`',
    `const apostrophe = "don't"`,
  ].join('\n')
  const texts = literals(sample).map((item) => item.text)
  assert.deepEqual(texts, [
    `'https://colloq.ru/// не комментарий'`,
    `"English"`,
    '`и это строка`',
    `"don't"`,
  ])
  assert.equal(literals(sample).filter((item) => CYRILLIC.test(item.text)).length, 2)
})

/**
 * «Семинар» ушёл из продукта в обоих написаниях.
 *
 * Русское слово убрали раньше — занятие называется занятием. Английское
 * «seminar» вернуло бы ту же путаницу с другой стороны: в панели Classes, в
 * CLI seminars. Ловим оба, и в примерах имён тоже: `colloq tunnel setup
 * seminar.example.ru` — это тот же словарь, просто в адресе.
 */
test('the CLI says class, in both alphabets', () => {
  const guilty: string[] = []
  for (const { name, source } of cliSources())
    source.split('\n').forEach((text, index) => {
      if (/семинар|seminar/i.test(text)) guilty.push(`cli/src/${name}:${index + 1}  ${text.trim()}`)
    })
  assert.deepEqual(guilty, [], 'занятие называется занятием:\n' + guilty.join('\n'))
})
