/**
 * Второй путь справки: сигнатура из ИСХОДНИКОВ, когда в ядре ещё ничего нет.
 *
 * `inspect_request` отвечает по пространству имён, а тетрадь открывают сверху
 * вниз: пока ячейку `import seaborn as sns` не запустили, живое ядро про
 * `sns.lmplot` не знает ничего и отвечает «не нашлось». Ровно это на занятии
 * выглядело как «справка не всегда появляется».
 *
 * Здесь проверяется всё, что в этом пути ломается молча:
 *   · шапка импортов — единственное, из чего jedi узнаёт, что `sns` это
 *     seaborn; собранная неверно, она превращает ответ в тишину, и понять это
 *     по экрану нельзя;
 *   · вопрос, который уезжает в ядро: позиция каретки после приклеенной шапки
 *     (разъехавшись на строку, jedi разобрал бы соседнее имя), скрытый модуль
 *     и `user_expressions`, потолки и будильник;
 *   · разбор ответа: отличить «не нашлось» от «ответа не было вовсе» важно —
 *     первое обычный исход, второе наша беда.
 *
 * Настоящий Python здесь не запускается: сам разбор проверен на живом ядре
 * `colloq-kernel:base` (jedi 0.20, seaborn 0.13.2), а сюита обязана идти на
 * машине без docker.
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  importHeader,
  inspectStaticSource,
  nameChainAt,
  parseStaticInspect,
  INSPECT_BUDGET_SEC,
  INSPECT_LIMIT_BYTES,
  INSPECT_MODULE,
  INSPECT_REPORT_EXPR,
} from '../server/src/kernel/inspect-static.js'

/* ------------------------------------------------------------ шапка импортов */

test('в шапку попадают импорты ячеек выше — и в том же порядке', () => {
  const header = importHeader([
    'import pandas as pd\nimport seaborn as sns\n',
    'data = pd.read_csv("train.csv")',
    'from sklearn.metrics import roc_auc_score',
  ])
  assert.deepEqual(header.split('\n'), [
    'import pandas as pd',
    'import seaborn as sns',
    'from sklearn.metrics import roc_auc_score',
  ])
})

test('в шапку не попадает то, что сломало бы разбор ВСЕЙ шапки', () => {
  const header = importHeader([
    // Отступ — значит импорт внутри try/функции: в шапке это IndentationError,
    // после которого jedi не разберёт ни одного имени.
    'try:\n    import cv2\nexcept ImportError:\n    cv2 = None',
    // Продолжение строки: хвоста у него в шапке не будет.
    'from typing import (\n    Any,\n    Dict,\n)',
    'import numpy as np \\',
    // Не Python вовсе.
    '%%bash\nimport nothing',
    'import numpy as np',
  ])
  assert.deepEqual(header.split('\n'), ['import numpy as np'])
})

test('повторы выбрасываются: одна строка стоит в половине учебных ячеек', () => {
  const header = importHeader(['import pandas as pd', 'import pandas as pd\nimport numpy as np'])
  assert.deepEqual(header.split('\n'), ['import pandas as pd', 'import numpy as np'])
})

test('шапка не растёт без предела — кадр к ядру не резиновый', () => {
  const many = Array.from({ length: 400 }, (_, i) => `import mod_${i}`)
  const header = importHeader([many.join('\n')])
  assert.ok(header.split('\n').length <= 60, `в шапку уехало ${header.split('\n').length} строк`)
  assert.ok(header.length <= 4 * 1024)
})

test('ячейки без импортов не стоят ничего и ничего не приносят', () => {
  assert.equal(importHeader(['x = 1', 'print(x)']), '')
  assert.equal(importHeader([]), '')
})

/* --------------------------------------------------------------- вопрос */

test('каретка переезжает ровно на столько строк, сколько в шапке', () => {
  const header = importHeader(['import seaborn as sns'])
  const code = 'fig = None\nsns.lmplot'
  const source = inspectStaticSource({ code, cursor: code.length, header })
  /*
   * Шапка — одна строка, ячейка — две: имя стоит на ТРЕТЬЕЙ строке склеенного
   * текста и в десятой колонке. Разъехавшись на строку, jedi разобрал бы
   * соседнее имя и уверенно ответил бы не о том.
   */
  assert.match(source, /\.look\(.*, 3, 10, "sns\.lmplot", /)
  assert.match(source, /"import seaborn as sns\\nfig = None\\nsns\.lmplot"/)
})

test('без шапки вопрос тот же, только без сдвига', () => {
  const source = inspectStaticSource({ code: 'sns.lmplot', cursor: 10 })
  assert.match(source, /\.look\("sns\.lmplot", 1, 10, "sns\.lmplot", /)
})

test('имя под кареткой берётся цепочкой — иначе в сигнатуре не то имя', () => {
  assert.equal(nameChainAt('sns.lmplot', 10), 'sns.lmplot')
  assert.equal(nameChainAt('df.head', 5), 'df.he')
  assert.equal(nameChainAt('x = 1\ndf.head', 13), 'df.head')
  assert.equal(nameChainAt('print(', 6), '')
})

test('вопрос ничего не оставляет в пространстве студента и ничего не печатает', () => {
  const source = inspectStaticSource({ code: 'x', cursor: 1 })
  // Модуль спрятан в sys.modules; в globals() не появляется ни одного имени.
  assert.match(source, new RegExp(`sys'\\)\\.modules\\[\\"${INSPECT_MODULE}\\"\\]`))
  assert.doesNotMatch(source, /^import /m, 'исходник связал имя в пространстве студента')
  // Установка идемпотентна: второй вопрос не перекомпилирует модуль.
  assert.match(source, /if getattr\(__import__\('sys'\)\.modules\.get\(/)
  // Ответ едет выражением — при silent в IOPUB не приходит ничего вовсе.
  assert.match(INSPECT_REPORT_EXPR, new RegExp(`modules\\['${INSPECT_MODULE}'\\]\\.report`))
})

test('у разбора есть будильник и потолок ответа, и оба уезжают в ядро', () => {
  const source = inspectStaticSource({ code: 'x', cursor: 1 })
  assert.match(source, new RegExp(`, ${INSPECT_BUDGET_SEC}, ${INSPECT_LIMIT_BYTES}\\)$`))
  // Обрывать надо ИЗНУТРИ: сервер, переставший ждать, ядро не освобождает.
  assert.match(source, /signal\.setitimer\(signal\.ITIMER_REAL, budget\)/)
  assert.match(source, /signal\.setitimer\(signal\.ITIMER_REAL, 0\)/)
  // Полторы секунды — замер, а не round number: см. INSPECT_BUDGET_SEC.
  assert.ok(INSPECT_BUDGET_SEC > 0 && INSPECT_BUDGET_SEC <= 2)
})

test('свои значения бюджета и потолка доезжают как есть', () => {
  const source = inspectStaticSource({ code: 'x', cursor: 1, budgetSec: 0.25, limitBytes: 512 })
  assert.match(source, /, 0\.25, 512\)$/)
})

/* ---------------------------------------------------------------- ответ */

test('ответ ядра читается и из user_expressions, и голой строкой', () => {
  const text = 'Signature:\nsns.lmplot(data)\nType: function'
  const json = JSON.stringify({ found: true, text })
  assert.deepEqual(parseStaticInspect(json), { found: true, text, why: null })
  assert.deepEqual(
    parseStaticInspect({ status: 'ok', data: { 'text/plain': json } }),
    { found: true, text, why: null },
  )
})

test('«не нашлось» и «ответа не было» — это разные ответы', () => {
  // Не нашлось: обычный исход, и причина у него своя.
  assert.deepEqual(parseStaticInspect(JSON.stringify({ found: false, why: 'nothing' })), {
    found: false,
    text: null,
    why: 'nothing',
  })
  assert.equal(parseStaticInspect(JSON.stringify({ found: false, why: 'no-jedi' })).why, 'no-jedi')
  assert.equal(parseStaticInspect(JSON.stringify({ found: false, why: 'timeout' })).why, 'timeout')

  // Ответа не было вовсе: модуль не установился, выражение не посчиталось.
  assert.equal(parseStaticInspect(null), null)
  assert.equal(parseStaticInspect('None'), null)
  assert.equal(parseStaticInspect('не json'), null)
  assert.equal(parseStaticInspect({ status: 'error', data: {} }), null)
  assert.equal(parseStaticInspect({ status: 'ok', data: {} }), null)
})

test('найденное без текста — это не найденное', () => {
  assert.equal(parseStaticInspect(JSON.stringify({ found: true, text: '' }))?.found, false)
  assert.equal(parseStaticInspect(JSON.stringify({ found: true }))?.found, false)
})
