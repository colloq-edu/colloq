/**
 * Отклик на нажатие в лекции: полоса ноутбука, кружки пера, мёртвый пульт.
 *
 * Ни у одной из этих строк нет ни функции, ни сокета — они живут в атрибуте
 * class и в ветке разметки, и ломаются молча: `transition-colors` вместо
 * перечисленных свойств выбрасывает из перехода transform, то есть само
 * нажатие, и на экране это ничем не отличается от «сервер задумался».
 * Проверять такое в браузере на каждой правке никто не будет, а откатывается
 * оно одной строкой — ровно так находка design-9 и появилась.
 *
 * Читается прямо из компонентов, тем же приёмом, что и panels-craft: тест со
 * своей копией правила проходит вечно, пока файл уезжает.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/** Разметка и стили без комментариев: объяснение — не обещание. */
function code(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

const VIEW = 'web/src/components/lecture/LectureView.svelte'
const CONSOLE = 'web/src/components/lecture/ConsoleView.svelte'

/* ------------------------------------------------------------- нажатие */

test('тулбар лекции прессуется, и transform не выброшен утилитой перехода', () => {
  const view = code(read(VIEW))
  const tool = /const TOOL =\s*((?:'[^']*'\s*\+?\s*)+)/.exec(view)
  assert.ok(tool, 'константа TOOL пропала из LectureView')
  const classes = tool[1]
  /*
   * Свойства перечислены, а не `transition-colors` плюс `.press`: утилита
   * Tailwind переписывает transition-property целиком, и transform из
   * помощника в список бы не попал — нажатие бы не анимировалось вовсе.
   */
  assert.match(classes, /transition-\[[^\]]*\btransform\b[^\]]*\]/, 'transform не в списке перехода')
  assert.match(classes, /\bduration-press\b/, 'нажатие идёт не по --speed-press')
  assert.match(classes, /enabled:active:scale-\[0\.97\]/, 'полоса лекции не отвечает на нажатие')
})

test('кружок пера меняет размер мгновенно, а нажатие отдано пальцу', () => {
  const view = code(read(VIEW))
  const each = /\{#each INKS as choice[\s\S]*?\{\/each\}/.exec(view)
  assert.ok(each, 'ряд перьев пропал из полосы лекции')
  const inks = each[0]
  // Состояние приходит само; анимировать его — рисовать его позже, чем оно
  // случилось. scale-110 остаётся, transition-transform уходит.
  assert.doesNotMatch(inks, /transition-transform/, 'смена состояния кружка снова анимирована')
  assert.match(inks, /scale-110/, 'выбранное перо перестало отличаться размером')
  // Помощник взят именем: других утилит перехода на кнопке нет, переписывать
  // transition-property некому.
  assert.match(inks, /class="press flex w-8/, 'кнопка пера не прессуется')
})

/* --------------------------------------------------- мёртвый пульт */

test('пульт объясняет расхождение с сервером своими словами и даёт перезагрузку', () => {
  const pult = code(read(CONSOLE))
  assert.match(
    pult,
    /import \{ reloadByHand \} from '@\/lib\/refusal'/,
    'перезагрузка рукой берётся не из общей копии правила',
  )
  /*
   * Плашка комнаты лежит выше пульта (SessionScreen, z-[100]), но собрана она
   * для окна с мышью. У пульта до этой ветки не оставалось ничего, кроме
   * красного шва рейла: клавиши погашены, лист висит, слов нет.
   */
  assert.match(pult, /\{:else if session\.stuck\}/, 'пульт снова молчит про расхождение')
  assert.match(pult, /onclick=\{\(\) => reloadByHand\(\)\}/, 'на пульте нет кнопки перезагрузки')
})
