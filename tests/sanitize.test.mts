/**
 * Что текстовая ячейка не имеет права принести в чужие браузеры.
 *
 * Список тегов проверяется в security-headers.test.mts вместе с заголовками —
 * здесь вторая половина той же политики, атрибуты.
 *
 * Атрибут `style` из этого файла ушёл, и ушёл не по недосмотру: запрет целиком
 * закрывал дыру (`<div style="position:fixed;inset:0">` — чёрный экран у всех
 * тридцати человек и у ноутбука в проекторе, поверх интерфейса, то есть ячейку
 * уже не удалить мышью) — но вместе с ней уносил всю привычную разметку
 * учебного ноутбука. Теперь считаются СВОЙСТВА, и считает их чистая функция,
 * которую проверяет note-css.test.mts по поведению, а не по исходнику.
 *
 * Здесь остаётся то, что иначе не проверить: markdown() зовёт
 * document.createElement и грузит dompurify динамическим импортом, то есть нужен
 * браузер, которого в этой сюите нет. А потеря строки — это одна строка в одном
 * месте, и такую строку видно чтением.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MARKDOWN_FORBIDDEN_ATTRS, MARKDOWN_FORBIDDEN_TAGS } from '../web/src/lib/sanitize.js'
import { safeStyle } from '../shared/note-css.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

test('a link in a note may not POST to a stranger', () => {
  // DOMPurify оставляет `ping` по умолчанию, и `<a href="…" ping="http://…">`
  // — это запрос из браузера того, кто нажал на ссылку в чужой заметке.
  assert.ok(MARKDOWN_FORBIDDEN_ATTRS.includes('ping'))
})

test('оформление заметки считается по свойствам, а не по запрету атрибута', () => {
  // Запрет `style` снят намеренно — но ровно в обмен на белый список свойств.
  // Пропадёт список, и вернётся тот самый оверлей на всю комнату.
  assert.ok(!MARKDOWN_FORBIDDEN_ATTRS.includes('style'))
  assert.equal(safeStyle('position:fixed;inset:0;background:#000'), 'background: #000')
})

test('a text cell may not play sound at the room', () => {
  // <audio autoplay loop> и его атрибуты — в списках DOMPurify по умолчанию, а
  // выключить это тому, у кого играет, нечем.
  assert.ok(MARKDOWN_FORBIDDEN_TAGS.includes('audio'))
  assert.ok(MARKDOWN_FORBIDDEN_TAGS.includes('video'))
})

test('a list of tasks is still a list of tasks', () => {
  // `- [ ] сделать` в GFM — это <input type=checkbox disabled>. Запретить input
  // значило бы починить оверлей ценой обычной заметки.
  for (const tag of ['input', 'canvas']) {
    assert.ok(!MARKDOWN_FORBIDDEN_TAGS.includes(tag), `${tag} is not a threat`)
  }
})

test('the one place that renders a note still hands the sanitizer both lists', () => {
  const source = read('web/src/lib/render.svelte.ts')
  const markdown = source.slice(source.indexOf('markdown(source)'), source.indexOf('ansi(text)'))
  assert.ok(
    markdown.includes('FORBID_ATTR: MARKDOWN_FORBIDDEN_ATTRS'),
    'markdown() рисует заметку без общего списка запрещённых атрибутов',
  )
  assert.ok(
    markdown.includes('safeStyle('),
    'markdown() пускает `style` из заметки в страницу, не считая свойств',
  )
})

test('оформление чистится ДО того, как формулы станут разметкой', () => {
  /*
   * Порядок двух проходов в markdown(), и он не косметический в обе стороны.
   * KaTeX раскладывает формулу `position: absolute` и `top` — тем, чего заметке
   * нельзя, — так что его вывод под фильтр попасть не должен, иначе дроби и
   * радикалы складываются в кашу. А чужой `style` обязан попасть. Разводит их
   * только порядок: сначала чужое, потом своё.
   */
  const source = read('web/src/lib/render.svelte.ts')
  const markdown = source.slice(source.indexOf('markdown(source)'), source.indexOf('ansi(text)'))
  assert.ok(markdown.indexOf('safeStyle(') < markdown.indexOf('katex.renderToString'))
})
