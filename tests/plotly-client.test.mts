/**
 * Сторона тетради: что она выбирает показать и что уезжает в рамку.
 *
 * Три отказа, каждый из которых виден только глазами и только на семинаре:
 *
 *  — выбор представления не знает про фигуру, и ячейка молча пуста (так и
 *    было: в наборе от plotly нет ни текста, ни картинки);
 *  — в рамку уезжает не только фигура, но и `config` из неё — то есть чужие
 *    настройки нашей панели инструментов, вплоть до адреса чужого сервера;
 *  — вывод, у которого после санитайзера не осталось ничего, снова рисуется
 *    пустым местом вместо слов.
 *
 * И одно правило про сборку: пять мегабайт plotly.js не должны оказаться в
 * куске, который качает каждый, кто открыл ссылку на занятие.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  PLOTLY_DEFAULT_HEIGHT,
  PLOTLY_MAX_HEIGHT,
  PLOTLY_MIME,
  PLOTLY_MSG,
  figureHeight,
  isPlotlyMessage,
  normalizeFigure,
} from '../shared/plotly.js'
import {
  asImage,
  hasVisibleMarkup,
  isPicture,
  pickMime,
  withBlobs,
} from '../web/src/components/notebook/output-mimes.js'
import type { CellOutput } from '../shared/notebook.js'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')

/* ------------------------------------------------------- выбор представления */

test('фигура выбирается, даже когда в наборе больше ничего нет', () => {
  // Ровно тот набор, который шлёт ipykernel с нынешним plotly: один ключ.
  // Пока его тут не было, `pickMime` возвращал null, а null — это пустое место.
  assert.equal(pickMime({ [PLOTLY_MIME]: '{}' }, true), PLOTLY_MIME)
  assert.equal(pickMime({ [PLOTLY_MIME]: '{}' }, false), PLOTLY_MIME, 'до рендерера — тоже')
  // И она старше снимка того же графика: повертеть можно только фигуру.
  assert.equal(pickMime({ [PLOTLY_MIME]: '{}', 'image/png': 'iVBOR' }, true), PLOTLY_MIME)
  // Старый порядок не тронут.
  assert.equal(pickMime({ 'image/png': 'iVBOR', 'text/plain': 'x' }, true), 'image/png')
  assert.equal(pickMime({ 'text/html': '<b>1</b>', 'text/plain': 'x' }, true), 'text/html')
})

test('фигуру не рисуют картинкой — ни по типу, ни по адресу', () => {
  // Вынесенная фигура приезжает адресом, точно как вынесенная картинка. По
  // адресу лежит JSON: `<img>` показал бы битую рамку на месте графика.
  assert.equal(asImage(PLOTLY_MIME, '/api/sessions/x/blobs/abc'), false)
  assert.equal(asImage('image/png', '/api/sessions/x/blobs/abc'), true)
  assert.equal(asImage('image/png', 'iVBORw0KGgo='), true)
})

test('график не подрезается кромкой «Show more»', () => {
  // Под кромкой у графика оказались бы нижняя ось и подписи, а кнопка обещала
  // бы продолжение вывода, которого там нет. Та же причина, что у картинок.
  const output: CellOutput = { kind: 'data', data: { [PLOTLY_MIME]: '{}' }, execCount: 1 }
  assert.equal(isPicture(output, true), true)
})

test('вынесенная фигура получает адрес тем же механизмом, что и картинка', () => {
  const output: CellOutput = {
    kind: 'data',
    data: {},
    blobs: [{ sha: 'abc', mime: PLOTLY_MIME, bytes: 900_000 }],
    execCount: 3,
  }
  const shown = withBlobs(output, (blob) => `/api/sessions/room/blobs/${blob.sha}`)
  assert.equal(shown.kind, 'data')
  if (shown.kind !== 'data') return
  assert.equal(shown.data[PLOTLY_MIME], '/api/sessions/room/blobs/abc')
})

/* -------------------------------------------------------- фигура для рамки */

test('в рамку уезжает только data, layout и frames', () => {
  const figure = normalizeFigure({
    data: [{ type: 'bar', x: [1], y: [2] }],
    layout: { height: 300 },
    frames: [{ name: 'a' }],
    // Всё, что ниже, — чужие настройки НАШЕЙ панели инструментов и мало ли
    // что ещё. В рамку это не едет.
    config: { plotlyServerURL: 'https://chart-studio.example', showSendToCloud: true },
    somethingNew: { x: 1 },
  })
  assert.ok(figure)
  assert.deepEqual(Object.keys(figure).sort(), ['data', 'frames', 'layout'])
  assert.equal((figure as Record<string, unknown>).config, undefined)
})

test('не фигура — значит, показывать нечего, и это говорится словами', () => {
  assert.equal(normalizeFigure(null), null)
  assert.equal(normalizeFigure('строка'), null)
  assert.equal(normalizeFigure([1, 2]), null)
  assert.equal(normalizeFigure({ layout: {} }), null, 'без data это не фигура')
  // Кривой layout не отменяет фигуру: рисовать по-прежнему есть что.
  assert.deepEqual(normalizeFigure({ data: [], layout: 'нет' }), { data: [], layout: {} })
})

test('высота приходит из фигуры, но в разумных пределах', () => {
  assert.equal(figureHeight({ data: [], layout: {} }), PLOTLY_DEFAULT_HEIGHT)
  assert.equal(figureHeight({ data: [], layout: { height: 620 } }), 620)
  // Число в layout пишет кто угодно: `height: 1e9` — это страница, которую
  // не пролистать, а `height: 1` — график в одну строку.
  assert.equal(figureHeight({ data: [], layout: { height: 1e9 } }), PLOTLY_MAX_HEIGHT)
  assert.equal(figureHeight({ data: [], layout: { height: 1 } }), 180)
  assert.equal(figureHeight({ data: [], layout: { height: 'высокий' } }), PLOTLY_DEFAULT_HEIGHT)
})

test('сообщение рамки узнаётся по метке, а не по форме наугад', () => {
  assert.ok(isPlotlyMessage({ colloq: PLOTLY_MSG, kind: 'ready' }))
  assert.ok(!isPlotlyMessage({ kind: 'ready' }))
  assert.ok(!isPlotlyMessage({ colloq: 'webpackHotUpdate', kind: 'ready' }))
  assert.ok(!isPlotlyMessage('ready'))
  assert.ok(!isPlotlyMessage(null))
})

/* --------------------------------------------- слова вместо пустого места */

test('вывод, от которого после санитайзера ничего не осталось, узнаётся', () => {
  // Bokeh, folium, altair без картинки, ipywidgets, plotly со старым
  // рендерером: вся работа в `<script>`, а скрипты из вывода мы не исполняем.
  assert.equal(hasVisibleMarkup('<div id="bk-1" class="bk-root"></div>'), false)
  assert.equal(hasVisibleMarkup('  \n  '), false)
  assert.equal(hasVisibleMarkup('<div><span> </span></div>'), false)
  // А настоящая разметка вывода — осталась.
  assert.equal(hasVisibleMarkup('<table><tr><td>1</td></tr></table>'), true)
  assert.equal(hasVisibleMarkup('<div>Решение</div>'), true)
  // Картинку видно и без единой буквы внутри.
  assert.equal(hasVisibleMarkup('<p><img src="data:image/png;base64,iVBOR"></p>'), true)
  assert.equal(hasVisibleMarkup('<svg><circle r="1"/></svg>'), true)
})

test('пустая строка text/plain остаётся законной пустотой', () => {
  // `print("")` и `display("")` — это вывод, который ПРАВДА пуст, и строка
  // про интерактивность здесь была бы враньём. Выбор до него доходит.
  assert.equal(pickMime({ 'text/plain': '' }, true), 'text/plain')
})

test('строку про интерактивный вывод рисует ровно одно место', () => {
  const source = read('web/src/components/notebook/CellOutputs.svelte')
  const uses = source.match(/room\.output\.interactive/g) ?? []
  assert.equal(uses.length, 2, 'веток две: вычищенная разметка и незнакомый набор')
  assert.ok(source.includes('hasVisibleMarkup('), 'разметку вывода больше не взвешивают')
})

/* ------------------------------------------------------------- сборка */

test('plotly.js не попадает в бандл приложения — ни в какой кусок', () => {
  /*
   * Пять мегабайт (1.1 МБ brotli) грузятся ТОЛЬКО внутри рамки и только когда
   * на экране есть график. Способ, которым это обеспечено, ровно один: ни один
   * исходник фронтенда пакет не импортирует — он копируется в `public/` шагом
   * сборки и цепляется скриптом уже в рамке.
   *
   * Проверяется по исходникам, а не по собранному: сборка в тестах занимает
   * полминуты, а импорт, случайно добавленный `import Plotly from …` ради
   * типов, видно чтением.
   */
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.resolve(import.meta.dirname, '..', dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(rel)
      else if (/\.(ts|svelte|js)$/.test(entry.name) && /from ['"]plotly\.js|require\(['"]plotly\.js/.test(read(rel))) {
        offenders.push(rel)
      }
    }
  }
  for (const dir of ['web/src', 'shared', 'server/src']) walk(dir)
  assert.deepEqual(offenders, [], `plotly.js импортируют:\n  ${offenders.join('\n  ')}`)

  // И копия для рамки действительно раскладывается шагом сборки — иначе
  // адрес в политике вёл бы в 404, а график был бы вечной заставкой.
  const web = JSON.parse(read('web/package.json')) as { scripts: Record<string, string> }
  assert.match(web.scripts['plotly:dist'], /plotly\.js-strict-dist-min/)
  assert.match(web.scripts['plotly:dist'], /public\/plotly\/plotly\.min\.js/)
  for (const script of ['dev', 'build']) {
    assert.match(web.scripts[script], /assets/, `${script} не раскладывает копии в public/`)
  }
  assert.match(web.scripts.assets, /plotly:dist/)
})

test('берётся strict-сборка: без неё политике рамки понадобился бы unsafe-eval', () => {
  const web = JSON.parse(read('web/package.json')) as { dependencies: Record<string, string> }
  assert.ok(web.dependencies['plotly.js-strict-dist-min'], 'strict-сборки нет в зависимостях')
  assert.equal(web.dependencies['plotly.js-dist-min'], undefined, 'обычная сборка тянет за собой eval')
})
