import { translate, tr } from '../shared/i18n.js'
/**
 * Стенд вживую ищет кнопки по подписям — и об этом больше некому напомнить.
 *
 * scripts/ui-check.mts водит настоящий Chrome и нажимает на то, что написано
 * на кнопке. Подпись меняется в компоненте, стенд об этом не узнаёт, и
 * `until(...)` ждёт результата до самого таймаута — молча, потому что ждать
 * ему нечего. Так уже было: «Стереть» в полосе лекции стала двухтактной
 * (wipeAsked), а стенд продолжал нажимать один раз — то есть только вооружал
 * кнопку и проверял стирание, которого не просил.
 *
 * Здесь сверяются две стороны одной подписи: то, что рисует LectureView, и то,
 * что ищет стенд. Живого браузера для этого не нужно, а `make ui` гоняют
 * руками и не каждый день.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8')

const view = read('web/src/components/lecture/LectureView.svelte')
const stand = read('scripts/ui-check.mts')

test('двухтактные подписи полосы лекции и стенд говорят об одних и тех же кнопках', () => {
  // Обе кнопки необратимы, и обе спрашивают вторым нажатием. Порядок в тернаре
  // важен: вопрос — это состояние «спросили», а не подпись в покое.
  assert.match(view, /\{wipeAsked \? tr\('room\.ui\.288'\) : tr\('room\.ui\.221'\)\}/)
  assert.match(view, /\{stopAsked \? tr\('room\.ui\.294'\) : tr\('room\.ui\.230'\)\}/)

  for (const label of ['room.ui.221', 'room.ui.288', 'room.ui.230', 'room.ui.294'].map(key => translate('ru', key))) {
    assert.ok(stand.includes(label), `ui-check не знает подписи «${label}»`)
  }
})

test('стенд нажимает на них дважды, а не один раз', () => {
  // Одно нажатие на двухтактную кнопку — это проверка, которая ничего не
  // проверяет: она вооружает кнопку и ждёт результата, которого не просила.
  assert.match(stand, /const pressTwice = async \(/)
  assert.match(stand, /pressTwice\(host, \['Стереть', 'Стереть всё\?'\]\)/)

  // У «Закончить» второе нажатие написано отдельно — между тактами стенд
  // проверяет, что первое только спросило.
  const at = stand.indexOf("'первое «Закончить» спрашивает, а не заканчивает'")
  assert.notEqual(at, -1, 'стенд больше не проверяет, что первое нажатие только спрашивает')
  const after = stand.slice(at)
  assert.match(
    after.slice(0, 600),
    /\['Закончить','Закончить лекцию\?'\]\.includes/,
    'после вопроса стенд не нажимает второй раз — лекция не закончится',
  )
})

test('стенд нажимает в тело ячейки — туда же, куда человек', () => {
  /*
   * Выделение слушает колонку тела, а поле с номером и просветы нарочно
   * нейтральны. Событие всплывает вверх: `pointerdown` в корень
   * `[data-cell-id]` до обработчика не доходит вовсе, и стенд, целившийся
   * туда, не выделял ничего — четыре проверки подряд обвиняли в этом продукт,
   * а пятая падала на `null` и уносила с собой весь хвост прогона.
   */
  const cell = readFileSync(path.join(root, 'web/src/components/notebook/CellView.svelte'), 'utf8')
  const body = cell.indexOf('data-cell-body')
  assert.notEqual(body, -1, 'у тела ячейки больше нет признака data-cell-body')
  assert.match(
    cell.slice(body, body + 200),
    /onpointerdown=\{\(event\) => onselect\(event\)\}/,
    'нажатие переехало с тела ячейки — стенд целится не туда',
  )
  assert.match(stand, /const body=cells\[\$\{n\}\]\.querySelector\('\[data-cell-body\]'\)/)
})
