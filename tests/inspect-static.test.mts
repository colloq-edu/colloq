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
import { spawnSync } from 'node:child_process'
import {
  importHeader,
  inspectBriefSource,
  inspectFactsSource,
  inspectStaticSource,
  looksLikeModule,
  parseBrief,
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

/* ------------------------------------------------------- строка про значение */

/**
 * «Хотя бы тип данных у переменной, быстрый тип и размерность» — просьба
 * владельца 21.09; вторая её половина не менее важна: «он там ещё добавлял
 * детальнее вагон текста, это не очень прикольно».
 *
 * Здесь проверяется то, что ломается тихо и дорого: ответ обязан быть O(1) и
 * БЕЗ побочных действий. У курсора базы данных, у генератора и у ленивой
 * коллекции `len()` и `repr()` могут стоить минуту работы или сдвинуть их с
 * места — а наведение мышью не имеет права ни того, ни другого.
 *
 * Гоняется настоящим python3: правило живёт в Python, и проверять его
 * подделкой значило бы проверять свои представления о нём.
 */
const PYTHON = (() => {
  const probe = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' })
  return probe.status === 0 ? 'python3' : null
})()

const HAS = (name: string) =>
  PYTHON !== null &&
  spawnSync(PYTHON, ['-c', `import ${name}`], { encoding: 'utf8' }).status === 0

/** Посчитать `setup`, спросить `expr` и вернуть разобранный ответ. */
function briefOf(setup: string, expr: string): ReturnType<typeof parseBrief> {
  const code = [
    setup,
    inspectBriefSource(expr),
    "print(__import__('sys').modules['_colloq_inspect'].report)",
  ].join('\n')
  const run = spawnSync(PYTHON as string, ['-c', code], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  return parseBrief(run.stdout.trim())
}

test('вопрос про значение ничего не исполняет и ничего не импортирует', () => {
  const source = inspectBriefSource('df.shape')
  assert.match(source, /\.brief\(globals\(\), "df\.shape"\)$/)
  assert.match(source, /getattr\(value, step, missing\)/)
  assert.doesNotMatch(source, /\beval\(/)
  // Незнакомому объекту не задают ни одного вопроса, кроме типа: ни len, ни
  // repr — см. заголовок раздела.
  assert.match(source, /Незнакомое: только имя типа/)
})

test('встроенные типы: размер, значение, тип элементов', { skip: PYTHON ? false : 'нет python3' }, () => {
  assert.deepEqual(briefOf('n = 42', 'n'), { type: 'int', value: '42' })
  assert.deepEqual(briefOf('flag = True', 'flag'), { type: 'bool', value: 'True' })
  assert.deepEqual(briefOf('nothing = None', 'nothing'), { type: 'NoneType', value: 'None' })
  assert.deepEqual(briefOf('names = ["a", "b", "c"]', 'names'), { type: 'list[str]', dims: '3' })
  // Разнородный список типом элементов не хвастается.
  assert.deepEqual(briefOf('mixed = [1, "a"]', 'mixed'), { type: 'list', dims: '2' })
  const pairs = briefOf('pairs = {"alpha": 1.5, "beta": 2.5}', 'pairs')
  assert.equal(pairs?.type, 'dict[str, float]')
  assert.equal(pairs?.dims, '2')
  assert.equal(pairs?.note, 'alpha, beta')
  const title = briefOf('title = "Цена квартиры в рублях за месяц аренды"', 'title')
  assert.equal(title?.type, 'str')
  assert.equal(title?.dims, '38')
  assert.match(title?.value ?? '', /^'Цена квартиры/)
})

test('длинное значение обрезается, а не показывается целиком', { skip: PYTHON ? false : 'нет python3' }, () => {
  const long = briefOf('s = "щ" * 500', 's')
  assert.equal(long?.dims, '500')
  assert.ok((long?.value?.length ?? 0) <= 41, `значение длиной ${long?.value?.length}`)
  assert.match(long?.value ?? '', /…$/)
})

test('функция, класс и модуль называются одной строкой', { skip: PYTHON ? false : 'нет python3' }, () => {
  assert.deepEqual(briefOf('def helper(a, b=1): pass', 'helper'), {
    type: 'function',
    note: 'helper(a, b=1)',
  })
  assert.deepEqual(briefOf('class Thing: pass', 'Thing'), { type: 'class', note: 'Thing' })
  assert.deepEqual(briefOf('import os', 'os'), { type: 'module', note: 'os' })
  // Обычный объект — только имя своего типа, и ни слова больше.
  assert.deepEqual(briefOf('class Thing: pass\nthing = Thing()', 'thing'), { type: 'Thing' })
})

test('у незнакомого объекта не зовут ни len, ни repr', { skip: PYTHON ? false : 'нет python3' }, () => {
  /*
   * Объект, у которого оба метода БРОСАЮТ: если их позовут, ответ станет
   * пустым или тест упадёт. Так выглядит курсор базы, у которого `len()` —
   * это запрос, и ленивая коллекция, которую `repr()` заставляет посчитаться.
   */
  const setup = [
    'class Costly:',
    '    def __len__(self): raise RuntimeError("дорого")',
    '    def __repr__(self): raise RuntimeError("дорого")',
    '    def __str__(self): raise RuntimeError("дорого")',
    'costly = Costly()',
  ].join('\n')
  assert.deepEqual(briefOf(setup, 'costly'), { type: 'Costly' })
})

test('имени нет — ответа нет', { skip: PYTHON ? false : 'нет python3' }, () => {
  assert.equal(briefOf('x = 1', 'нетТакого'), null)
  assert.equal(briefOf('x = 1', 'x.нетТакого'), null)
  assert.equal(briefOf('x = 1', ''), null)
})

test('цепочка атрибутов читается по точкам', { skip: PYTHON ? false : 'нет python3' }, () => {
  const setup = 'class Box:\n    def __init__(self): self.size = (3, 4)\nbox = Box()'
  assert.deepEqual(briefOf(setup, 'box.size'), { type: 'tuple[int]', dims: '2' })
})

test('pandas и numpy отвечают размером и типом данных', { skip: HAS('numpy') ? false : 'нет numpy' }, () => {
  const X = briefOf('import numpy as np\nX = np.zeros((100, 3))', 'X')
  assert.deepEqual(X, { type: 'ndarray', dtype: 'float64', dims: '(100, 3)' })
  // Скаляр numpy — это ЗНАЧЕНИЕ, а не «np.float64(3.5)».
  const one = briefOf('import numpy as np\none = np.float64(3.5)', 'one')
  assert.deepEqual(one, { type: 'float64', value: '3.5' })
})

test('DataFrame и Series: строки, столбцы, тип данных', { skip: HAS('pandas') ? false : 'нет pandas' }, () => {
  const setup = 'import pandas as pd\ndf = pd.DataFrame({"a": [1.0, 2.0], "b": [3.0, 4.0]})'
  assert.deepEqual(briefOf(setup, 'df'), { type: 'DataFrame', dims: '2 × 2' })
  const series = briefOf(setup + '\ns = df["a"]', 's')
  assert.equal(series?.type, 'Series')
  assert.equal(series?.dims, '2')
  assert.equal(series?.dtype, 'float64')
  assert.equal(series?.note, 'a')
  // `df.shape` — обычный кортеж, и отвечают про него как про кортеж.
  assert.deepEqual(briefOf(setup, 'df.shape'), { type: 'tuple[int]', dims: '2' })
})

test('оценщик sklearn говорит, обучен ли он, — не вызывая методов', {
  skip: HAS('sklearn') ? false : 'нет sklearn',
}, () => {
  const setup = 'from sklearn.linear_model import LinearRegression\nmodel = LinearRegression()'
  assert.deepEqual(briefOf(setup, 'model'), { type: 'LinearRegression', note: 'не обучен' })
})
