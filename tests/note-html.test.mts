/**
 * HTML в текстовой ячейке — на выгруженной странице.
 *
 * Отрисовщиков заметки два, и это осознанный размен (см. шапку
 * server/src/publish/render.ts): в комнате marked с DOMPurify, на статической
 * странице — своё подмножество без единого скрипта. Разойтись они могут, и
 * однажды разойдутся; здесь проверяется та половина, которая до сих пор
 * расходилась молча.
 *
 * А расходилась она целиком: заметка уходила в `esc()`, и `<div style="…">` из
 * учебного ноутбука доезжал до студента напечатанными тегами, тогда как в
 * комнате та же ячейка рисовалась.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderStep } from '../server/src/publish/render.js'
import type { PublicCell } from '../shared/publish.js'

/** Страница одного шага с единственной заметкой. */
function note(source: string, depth: 1 | 2 = 1): string {
  const cell: PublicCell = { id: 'n1', type: 'markdown', source, outputs: [], execCount: null, ranMs: null }
  const page = renderStep({
    title: 'Деревья и леса',
    publishedAt: 1,
    course: { name: 'Прикладной ML', handle: 'ml-strong' },
    steps: [{ seq: 3, label: 'шаг', at: 1, cellCount: 1 }],
    step: { seq: 3, label: 'шаг', at: 1, cells: [cell] },
    depth,
    base: 'https://colloq.ru',
  })
  const start = page.indexOf('<div class="note">')
  assert.notEqual(start, -1, 'заметки на странице нет вовсе')
  const end = page.indexOf('\n<div class="take">', start)
  return page.slice(start, end === -1 ? undefined : end)
}

test('разметка внутри строки рисуется, а не печатается', () => {
  const html = note('текст <b>жирный</b> и <i>курсив</i>')
  assert.match(html, /<b>жирный<\/b>/)
  assert.match(html, /<i>курсив<\/i>/)
  assert.doesNotMatch(html, /&lt;b&gt;/)
})

test('врезка «Замечание» доезжает с оформлением', () => {
  const html = note('<div style="background:#eef;padding:8px">\nВажно\n</div>')
  assert.match(html, /<div style="background: #eef; padding: 8px">/)
  assert.match(html, /Важно/)
})

test('блок разметки не разрезается на абзацы', () => {
  // Пока блока здесь не было, каждая строка дива оборачивалась в <p>, и
  // `<p><div …></p>` браузер чинил по-своему — врезка разъезжалась.
  const html = note('<div class="x">\nпервая\nвторая\n</div>')
  assert.doesNotMatch(html, /<p><div/)
})

test('центрирование через пустую строку остаётся одним блоком', () => {
  // Самый частый способ отцентрировать заголовок в ноутбуке. Пустые строки
  // режут его на три куска, и заголовок обязан остаться ВНУТРИ дива.
  const html = note('<div align="center">\n\n# Заголовок\n\n</div>')
  const div = html.indexOf('<div align="center">')
  const head = html.indexOf('<h2>Заголовок</h2>')
  const close = html.indexOf('</div>', div + 1)
  assert.ok(div !== -1 && head !== -1, 'див или заголовок потерялись')
  assert.ok(div < head && head < close, 'заголовок встал не внутри дива')
})

test('таблица и details — как написаны', () => {
  // Переводы строк остаются на местах: вёрстка их не читает, а сравнение
  // выгруженной страницы с прошлой версией — читает.
  const html = note('<table>\n<tr><th>a</th><td>1</td></tr>\n</table>')
  assert.match(html, /<table>\n<tr><th>a<\/th><td>1<\/td><\/tr>\n<\/table>/)
  assert.match(note('<details><summary>подсказка</summary>ответ</details>'), /<summary>подсказка<\/summary>/)
})

test('картинка заметки — записью публикации, на любой глубине', () => {
  const sha = 'a'.repeat(64)
  assert.match(note(`<img src="blob:${sha}.png" alt="схема">`, 1), new RegExp(`src="blob/${sha}\\.png"`))
  assert.match(note(`<img src="blob:${sha}.png" alt="схема">`, 2), new RegExp(`src="\\.\\./blob/${sha}\\.png"`))
})

test('оверлей на всю страницу не собирается и здесь', () => {
  const html = note('<div style="position:fixed;inset:0;background:#000;z-index:9999">×</div>')
  assert.doesNotMatch(html, /position/)
  assert.doesNotMatch(html, /z-index/)
  assert.match(html, /<div style="background: #000">/)
})

test('скрипт и таблица стилей выброшены вместе с содержимым', () => {
  const html = note('<script>alert(1)</script><style>* { display: none }</style>текст')
  assert.doesNotMatch(html, /alert/)
  assert.doesNotMatch(html, /display: ?none/)
  assert.match(html, /текст/)
})

test('адрес ссылки — только тот, что откроется страницей', () => {
  assert.doesNotMatch(note('<a href="javascript:alert(1)">жми</a>'), /javascript:/)
  assert.match(note('<a href="https://colloq.ru">сюда</a>'), /href="https:\/\/colloq\.ru"/)
})

test('незакрытый див не утаскивает вёрстку страницы', () => {
  const html = note('<div style="padding:8px">начал и забыл')
  assert.equal((html.match(/<div/g) ?? []).length, (html.match(/<\/div>/g) ?? []).length)
})

test('незакрытый жирный не переживает свой абзац', () => {
  // Стопка тегов у строки СВОЯ: иначе `<p><b>текст</p>…</b>` — и жирным
  // становится вся оставшаяся заметка.
  const html = note('<b>начал\n\nобычный абзац')
  assert.match(html, /<p><b>начал<\/b><\/p>/)
})

test('класс из заметки до правил страницы не доезжает', () => {
  // У страницы свои `.err`, `.quiet`, `.code`: заметка с чужим классом
  // читалась бы как ошибка выполнения.
  assert.doesNotMatch(note('<div class="err">обычный текст</div>'), /class="err"/)
})

test('обычный markdown не сломался', () => {
  const html = note('# Заголовок\n\n- раз\n- два\n\n**жирно** и `код`\n\n```\nx = 1\n```')
  assert.match(html, /<h2>Заголовок<\/h2>/)
  assert.match(html, /<ul><li>раз<\/li><li>два<\/li><\/ul>/)
  assert.match(html, /<strong>жирно<\/strong>/)
  assert.match(html, /<code>код<\/code>/)
  assert.match(html, /<pre class="code">x = 1<\/pre>/)
})

test('одинокая угловая скобка остаётся текстом', () => {
  assert.match(note('если a < b, то'), /a &lt; b/)
})

test('display(Markdown(…)) рисуется словами, а не именем класса', () => {
  /*
   * Ядро присылает два представления: саму разметку и `text/plain` с репром
   * `<IPython.core.display.Markdown object>`. Пока markdown не выбирался,
   * побеждал репр, и на месте вывода человек читал имя класса — вывод как бы
   * был и как бы отсутствовал.
   */
  const cell: PublicCell = {
    id: 'c1',
    type: 'code',
    source: 'display(Markdown("**Решение**: брать медиану"))',
    outputs: [
      {
        kind: 'data',
        data: {
          'text/markdown': '**Решение**: брать медиану',
          'text/plain': '<IPython.core.display.Markdown object>',
        },
        execCount: 4,
      },
    ],
    execCount: 4,
    ranMs: null,
  }
  const page = renderStep({
    title: 'T',
    publishedAt: 1,
    course: { name: 'C', handle: 'c' },
    steps: [{ seq: 3, label: 'шаг', at: 1, cellCount: 1 }],
    step: { seq: 3, label: 'шаг', at: 1, cells: [cell] },
    depth: 1,
    base: 'https://colloq.ru',
  })
  assert.match(page, /<strong>Решение<\/strong>/)
  assert.doesNotMatch(page, /IPython\.core\.display/)
})
