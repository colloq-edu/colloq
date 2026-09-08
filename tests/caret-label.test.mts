/**
 * Плашка с именем над чужой кареткой: чей стиль на ней и кто её режет.
 *
 * Ломалось это двумя способами сразу, и оба молчали.
 *
 * ПЕРВЫЙ — старшинство. y-codemirror.next объявляет плашку своей БАЗОВОЙ темой,
 * а базовая тема CodeMirror — это `.ͼ1 .cm-ySelectionInfo`, два класса. Правило
 * в один класс проигрывало ей наполовину: высота плашки, капитель и разрядка
 * приезжали из index.css, а шрифт, кегль, начертание, интерлиньяж, поля и
 * подъём оставались чужими. На экране была плашка 14 px с ЗАСЕЧНЫМ текстом
 * 9.75 px обычного начертания, прижатым к верхнему краю, — при том что в
 * index.css написано 8.5 px, sans, 700 и интерлиньяж во всю плашку.
 *
 * ВТОРОЙ — обрезка. Плашка висит НАД строкой, а `.cm-scroller` ячейки резал всё
 * выше первой строки: `overflow-x: auto` из index.css делает вторую ось
 * обрезающей, и `overflow-y: hidden` это закрепляло. От плашки оставалось
 * девять пикселей из четырнадцати — буквы срезаны по горизонту. В файле
 * скроллер настоящий и резать обязан, поэтому там плашке дан запас сверху.
 *
 * Оба измерены живьём (Chrome по CDP, двое в комнате, наведение настоящей
 * мышью): до правки — `serif · 9.75px · 400` и срез 5 px, после — `HSE Sans ·
 * 8.5px · 700`, не режет никто, над первой строкой файла 18 px.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

const CSS = read('web/src/index.css')
const CELL = read('web/src/components/notebook/CodeEditor.svelte')
const FILE_THEME = read('web/src/components/editor/editor-theme.ts')

/** Тело правила по началу его селектора. */
function ruleFor(css: string, selector: string): string {
  const at = css.indexOf(selector)
  assert.ok(at > 0, `правила ${selector} нет вовсе`)
  const open = css.indexOf('{', at)
  return css.slice(open + 1, css.indexOf('}', open))
}

const LABEL = '.cm-editor .cm-ySelectionCaret > .cm-ySelectionInfo'
const label = ruleFor(CSS, LABEL)

/** Число у свойства: `top: -14px` → -14. */
function px(rule: string, prop: string): number {
  const found = rule.match(new RegExp(`(?:^|\\s)${prop}:\\s*(-?[\\d.]+)px`))
  assert.ok(found, `${prop} в пикселях не задан`)
  return Number(found[1])
}

/* ------------------------------------------------------------- старшинство */

test('правило плашки старше базовой темы y-codemirror', () => {
  // Три класса против двух у `.ͼ1 .cm-ySelectionInfo` — и без !important.
  assert.ok(CSS.includes(LABEL), 'селектор ослаб: базовая тема снова победит')
  // Одноклассового правила остаться не должно: оно и было тем, что проигрывало.
  assert.doesNotMatch(CSS, /^\.cm-ySelectionInfo\s*\{/m, 'вернулось правило в один класс')
})

test('плашка объявляет всё, что объявляет базовая тема, — или сознательно уступает', () => {
  /*
   * Список свойств берётся из САМОЙ базовой темы, а не из головы: пусть новая
   * версия y-codemirror добавит туда шрифт или отступ — тест упадёт, и на
   * плашку посмотрят, вместо того чтобы обнаружить чужой стиль на экране.
   */
  const source = read('node_modules/y-codemirror.next/dist/y-codemirror.cjs')
  const at = source.indexOf("'.cm-ySelectionInfo': {")
  assert.ok(at > 0, 'в y-codemirror больше нет базового стиля плашки — проверить правило руками')
  const base = source.slice(at, source.indexOf('}', at))
  const declared = [...base.matchAll(/(\w+):/g)].map(([, name]) =>
    name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`),
  )
  /*
   * Что оставлено базе намеренно: расположение (плашка позиционируется
   * относительно каретки), фон (наследует цвет соседа — он и красит плашку) и
   * появление по наведению вместе с его плавностью.
   */
  const toBase = new Set([
    'position',
    'background-color',
    'opacity',
    'transition',
    'transition-delay',
    'user-select',
    'left',
  ])
  for (const prop of declared) {
    if (toBase.has(prop)) continue
    // База пишет `paddingLeft`/`paddingRight`, а наше правило — сокращение
    // `padding`: оно перекрывает обе стороны, и этого довольно.
    const dash = prop.indexOf('-')
    const short = dash > 0 ? prop.slice(0, dash) : prop
    const declares = new RegExp(`(?:^|\\s)(?:${prop}|${short}):`)
    assert.match(label, declares, `${prop} остаётся чужим`)
  }
})

test('плашка стоит ровно на строке, и мерено это пикселями, а не em', () => {
  /*
   * `em` здесь считается от кегля САМОЙ плашки (8.5 px), а не от строки кода:
   * «-1.2em» поднимало её на 10 px вместо её же 14, и низ налезал на код.
   */
  assert.doesNotMatch(label, /top:\s*-?[\d.]+em/, 'подъём снова в em')
  assert.equal(px(label, 'top'), -px(label, 'height'), 'подъём разошёлся с высотой плашки')
  // Интерлиньяж во всю плашку — иначе текст прижимается к её верхнему краю.
  assert.equal(px(label, 'line-height'), px(label, 'height'))
})

/* ----------------------------------------------------------------- обрезка */

test('ячейка не режет ничего: плашке есть куда выйти за первую строку', () => {
  const scroller = ruleFor(CELL, '.cm-cell :global(.cm-scroller)')
  assert.match(scroller, /overflow:\s*visible/, 'скроллер ячейки снова обрезает')
  assert.doesNotMatch(scroller, /overflow-y:\s*hidden/)
})

test('в файле скроллер режет, поэтому плашке дан запас сверху', () => {
  // Там окно в длинный файл: не резать он не может, значит место надо дать.
  const found = FILE_THEME.match(/paddingTop:\s*'(\d+)px'/)
  assert.ok(found, 'запаса сверху в редакторе файлов нет')
  assert.ok(
    Number(found[1]) >= px(label, 'height'),
    `запас ${found[1]}px меньше плашки ${px(label, 'height')}px`,
  )
})
