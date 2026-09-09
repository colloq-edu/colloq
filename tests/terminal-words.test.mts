import { translate, tr } from '../shared/i18n.js'
/**
 * Ящик терминала говорит на одном языке — включая состояние машины.
 *
 * 'starting', 'idle', 'dead' — слова протокола, и в коде они и должны быть
 * такими. Но в ящике они попадали прямо в русскую строку: «ядро python ·
 * starting — оболочка · idle» в журнале ядра и голое `idle` в строке команды,
 * под русским приглашением «оболочка запускается…». Это та же находка, что и
 * про заголовки панелей, только последняя её половина — машинная.
 *
 * Слова живут в `shared/machine.ts` одним списком: `Record` от типа не даст
 * появиться состоянию без имени, а этот тест держит две вещи, которых тип не
 * видит, — что имена русские и что разметка берёт их, а не печатает статус.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KERNEL_WORD, SHELL_WORD } from '../shared/machine.js'

const DRAWER = 'web/src/components/panels/TerminalDrawer.svelte'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Члены строкового объединения — прямо из объявления типа, а не списком здесь. */
function unionOf(rel: string, name: string): string[] {
  const line = new RegExp(`export type ${name} =([^\\n]+)`).exec(read(rel))
  assert.ok(line, `${name}: не нашли объявление`)
  return [...line[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

test('каждому состоянию протокола подобрано русское слово', () => {
  for (const [rel, name, words] of [
    ['shared/notebook.ts', 'KernelStatus', KERNEL_WORD],
    ['shared/protocol.ts', 'TerminalStatus', SHELL_WORD],
  ] as const) {
    const states = unionOf(rel, name)
    assert.ok(states.length >= 5, `${name}: разобрали объединение`)
    for (const state of states) {
      const word = (words as Record<string, string | undefined>)[state]
      assert.ok(word, `${name}.${state} — состояние без слова`)
      assert.doesNotMatch(word, /[A-Za-z]/, `${name}.${state}: «${word}» — не русское слово`)
    }
    assert.equal(Object.keys(words).length, states.length, `${name}: лишних слов нет`)
  }
})

test('оболочка названа одинаково в строке команды и в списке слов', () => {
  // Одно состояние, названное в одном ящике дважды по-разному, читается как
  // два разных: приглашение строки писалось раньше списка, и оно же — эталон.
  const term = read(DRAWER)
  for (const [state, prompt, key] of [
    ['starting', 'оболочка запускается…', 'room.ui.703'],
    ['dead', 'оболочка остановилась', 'room.ui.704'],
    ['closed', 'оболочка не запущена', 'room.ui.705'],
  ] as const) {
    assert.ok(term.includes(`tr('${key}')`), `приглашение «${prompt}» на месте`)
    assert.equal(translate('ru', key), prompt)
    assert.ok(prompt.includes(SHELL_WORD[state]), `«${prompt}» и «${SHELL_WORD[state]}» — одно слово`)
  }
})

test('разметка ящика не печатает состояние машины как есть', () => {
  const markup = read(DRAWER)
    .split('</script>')[1]
    .split('<style>')[0]
    .replace(/<!--[\s\S]*?-->/g, '')

  assert.doesNotMatch(markup, /\{\s*status\s*\}/, 'голое `starting`/`idle` в строке команды')
  assert.doesNotMatch(markup, /\{[^{}]*kernelStatus[^{}]*\}/, 'голый статус ядра в журнале')
  assert.match(markup, /\{kernelWord\}/, 'ядро названо словом')
  assert.match(markup, /\{shellWord\}/, 'оболочка названа словом')
  assert.match(
    read(DRAWER),
    /import \{ KERNEL_WORD, SHELL_WORD \} from '@shared\/machine'/,
    'слова берутся из общего списка, а не своей копией',
  )
})
