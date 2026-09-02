/**
 * Что текстовая ячейка не имеет права принести в чужие браузеры.
 *
 * Список тегов проверяется в security-headers.test.mts вместе с заголовками —
 * здесь вторая половина той же политики, атрибуты, и она стоила ровно тех же
 * последствий: тег <style> был запрещён, а АТРИБУТ style DOMPurify оставляет по
 * умолчанию и значение его не разбирает. `<div style="position:fixed;inset:0">`
 * — чёрный экран у всех тридцати человек и у ноутбука в проекторе, поверх
 * интерфейса, то есть удалить ячейку мышью уже нельзя.
 *
 * По исходнику, а не по поведению, и это осознанно: markdown() зовёт
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8')

test('a text cell may not carry a style attribute', () => {
  assert.ok(MARKDOWN_FORBIDDEN_ATTRS.includes('style'))
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
})
