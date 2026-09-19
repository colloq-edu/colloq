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
  inspectFactsSource,
  inspectStaticSource,
  looksLikeModule,
  withModuleFacts,
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
  /*
   * Две с половиной секунды — замеренный потолок, а не круглое число: первый
   * разбор pandas на холодном контейнере стоит ~1,5 с, и прежние полторы
   * секунды резали ровно его (замер 20.09: pd.DataFrame — 1946 мс). Больше
   * трёх нельзя: на это время занят shell ядра, и Run ждёт.
   */
  assert.ok(INSPECT_BUDGET_SEC >= 2 && INSPECT_BUDGET_SEC <= 3)
})

test('у модуля без документации показывается хотя бы то, ЧТО это', () => {
  const source = inspectStaticSource({ code: 'pd', cursor: 2 })
  /*
   * У pandas в `__init__.py` строки документации нет вовсе, а у numpy есть — и
   * до 20.09 это означало, что наведение на `np` отвечает страницей, а на
   * соседний `pd` — «сказать нечего». Разница, которой человек объяснить не
   * может. Теперь у такого имени показывается его род и полное имя, тем же
   * полем, каким это показывает сам IPython.
   */
  assert.match(source, /String form: </)
  assert.match(source, /full_name/)
  // И выбирается лучшее из найденного: у pd.read_csv jedi отдаёт пять
  // перегрузок из .pyi, и документация есть не у каждой.
  assert.match(source, /rank = 2 if \(sig and doc\.strip\(\)\)/)
})

test('свои значения бюджета и потолка доезжают как есть', () => {
  const source = inspectStaticSource({ code: 'x', cursor: 1, budgetSec: 0.25, limitBytes: 512 })
  assert.match(source, /, 0\.25, 512\)$/)
})

/* ------------------------------------------------------------- модуль */

/**
 * Про модуль отвечает его ПАКЕТ, а не объект.
 *
 * «module · <module pandas>», «module · <module seaborn>» — то, что
 * преподаватель увидел 21.09. У pandas строка документации модуля собирается
 * присваиванием `__doc__` в рантайме, у seaborn её нет вовсе, а IPython про
 * оба говорит одно: род, адрес в памяти и `<no docstring>`. Имя, под которым
 * пакет ставят, его версия, описание и ссылка на документацию лежат рядом с
 * ним на диске (dist-info) и читаются БЕЗ импорта — наведение мышью не имеет
 * права исполнять чужой код.
 */
test('вопрос про живой модуль ничего не импортирует и ничего не вычисляет', () => {
  const source = inspectFactsSource('plt')
  // Пространство имён студента уезжает аргументом: модуль там уже есть.
  assert.match(source, /\.facts\(globals\(\), "plt", \d+\)$/)
  // Ни eval, ни import пользовательского модуля: только точки и getattr.
  assert.match(source, /getattr\(value, step, None\)/)
  assert.doesNotMatch(source, /\beval\(/)
  assert.doesNotMatch(source, /__import__\((?!'sys'|'types')/)
  // Карта «модуль → дистрибутив» считается один раз на ядро: 84 мс на образе.
  assert.match(source, /_dists = md\.packages_distributions\(\)/)
  assert.match(source, /if _dists is None:/)
})

test('секции про пакет встают СВЕРХУ, а шапка IPython снимается', () => {
  const live = [
    'Type:        module',
    "String form: <module 'seaborn' from '/usr/local/lib/python3.11/site-packages/seaborn/__init__.py'>",
    'File:        /usr/local/lib/python3.11/site-packages/seaborn/__init__.py',
    'Docstring:   <no docstring>',
  ].join('\n')
  const facts = [
    'Module: seaborn',
    'Type: module',
    'Package: seaborn 0.13.2',
    'Summary: Statistical data visualization',
    'Docs: http://seaborn.pydata.org',
  ].join('\n')
  const merged = withModuleFacts(live, facts)
  assert.ok(merged.startsWith('Module: seaborn\n'), merged)
  /*
   * Повторный `Type:` разбор на клиенте — справедливо — считает частью
   * открытого раздела: ссылка на документацию превратилась бы в
   * «https://… Type: module». Ведущая шапка снимается целиком.
   */
  assert.equal((merged.match(/^Type:/gm) ?? []).length, 1)
  assert.doesNotMatch(merged, /String form:/)
  assert.doesNotMatch(merged, /site-packages/)
  // А документация (какая есть) остаётся на месте.
  assert.match(merged, /Docstring:/)
})

test('такая же строка ВНУТРИ документации остаётся текстом', () => {
  const live = ['Type: module', 'Docstring:', 'Пример:', 'File: example.csv', 'и дальше'].join('\n')
  const merged = withModuleFacts(live, 'Module: mytool\nType: module')
  assert.match(merged, /File: example\.csv/)
  assert.match(merged, /и дальше/)
})

test('дополнять нечем — ответ уезжает как есть', () => {
  const live = 'Type: module\nDocstring:\nOS routines.'
  assert.equal(withModuleFacts(live, ''), live)
  assert.equal(withModuleFacts(live, '   '), live)
})

test('«это модуль» узнаётся по тому же слову, что видит клиент', () => {
  assert.equal(looksLikeModule('Type:        module'), true)
  assert.equal(looksLikeModule('Signature: f(x)\nType: function'), false)
  // Не ловим слово посреди документации: заголовок стоит с начала строки.
  assert.equal(looksLikeModule('Docstring:\n  Type: module (в примере)'), false)
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
