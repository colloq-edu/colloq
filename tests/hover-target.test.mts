/**
 * Куда можно навести за справкой — и куда нельзя.
 *
 * Жалоба с занятия 21.09, дословно: «чтобы документация появлялась только при
 * наведении на пакеты, на их импорт и на названия самих функций — и не
 * выделялась бы при наведении просто на строку или на аргументы вызова
 * функции, потому что иначе у нас при любом наведении на код или при написании
 * кода будет что-то всплывать, и это неприкольно».
 *
 * До этого цель искалась регуляркой по строке: ЛЮБОЕ слово под указателем,
 * включая имя колонки в кавычках, `x=` в списке аргументов и слово в
 * комментарии. И каждое такое наведение стоило кадра `inspect` в сокете и
 * вопроса к общему ядру комнаты — то есть цена ошибки была не только в окне,
 * выскочившем не вовремя.
 *
 * Здесь проверяется таблица случаев настоящим парсером Python (тем же
 * @lezer/python, которым редактор красит код) — на деревьях, собранных из
 * текста, а не на выдуманных узлах: правило живёт именами узлов грамматики, и
 * подделанное дерево проверяло бы наши представления о ней, а не её саму.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { python } from '@codemirror/lang-python'
import {
  caretTarget,
  hoverTarget,
  moduleAliases,
  type HoverRefusal,
} from '../web/src/lib/hover-target.js'

const parser = python().language.parser

/** Псевдонимы учебной тетради: ими живёт третье правило. */
const ALIASES = moduleAliases([
  'import numpy as np',
  'import pandas as pd\nimport plotly.express as px',
  'from sklearn.linear_model import LinearRegression as LR',
  'import seaborn as sns\nimport os',
])

/**
 * Навестись на слово — и сказать, что вышло.
 *
 * Позиция берётся внутри слова (первая буква плюс один знак): так приходит
 * настоящее наведение, и так же ведёт себя каретка.
 */
function hover(code: string, word: string, nth = 0): string {
  const tree = parser.parse(code)
  let at = -1
  for (let i = 0; i <= nth; i++) at = code.indexOf(word, at + 1)
  assert.ok(at !== -1, `в коде нет «${word}»`)
  const answer = hoverTarget({ tree, doc: code, at: at + 1, aliases: ALIASES })
  return answer.target ? `${answer.target.kind}:${answer.target.ask}` : `нет:${answer.why as HoverRefusal}`
}

function caret(code: string, at: number): string {
  const answer = caretTarget({ tree: parser.parse(code), doc: code, at, aliases: ALIASES })
  return answer.target ? `${answer.target.kind}:${answer.target.ask}` : `нет:${answer.why as HoverRefusal}`
}

/* ------------------------------------------------------------- что можно */

test('имя в операторе импорта спрашивается целиком — и модуль, и псевдоним', () => {
  const plain = 'import numpy as np'
  assert.equal(hover(plain, 'numpy'), 'help:numpy')
  assert.equal(hover(plain, 'np'), 'help:np')

  const dotted = 'import matplotlib.pyplot as plt'
  assert.equal(hover(dotted, 'matplotlib'), 'help:matplotlib')
  // Подмодуль спрашивается вместе с пакетом: `pyplot` сам по себе не значит ничего.
  assert.equal(hover(dotted, 'pyplot'), 'help:matplotlib.pyplot')

  const from = 'from sklearn.linear_model import LinearRegression as LR'
  assert.equal(hover(from, 'sklearn'), 'help:sklearn')
  assert.equal(hover(from, 'linear_model'), 'help:sklearn.linear_model')
  assert.equal(hover(from, 'LinearRegression'), 'help:LinearRegression')
  assert.equal(hover(from, 'LR'), 'help:LR')
})

test('имя вызываемого — и своё, и через точку, и у конструктора', () => {
  assert.equal(hover('print("hi")', 'print'), 'help:print')
  assert.equal(hover('sns.lmplot(data=df)', 'lmplot'), 'help:sns.lmplot')
  assert.equal(hover('LR()', 'LR'), 'help:LR')
  // Вложенный вызов — тоже вызов: `g` в `f(g(x))` спрашивают, хотя он и стоит
  // внутри списка аргументов.
  assert.equal(hover('f(g(x))', 'g'), 'help:g')
})

test('декоратор — это вызов, который делает сам Python', () => {
  assert.equal(hover('@lru_cache\ndef f(x):\n    return x', 'lru_cache'), 'help:lru_cache')
  assert.equal(hover('@lru_cache(maxsize=2)\ndef f(x):\n    return x', 'lru_cache'), 'help:lru_cache')
  // А его аргументы — всё те же аргументы.
  assert.equal(hover('@lru_cache(maxsize=2)\ndef f(x):\n    return x', 'maxsize'), 'нет:keyword-argument')
})

test('раннее звено цепочки — только у известного псевдонима', () => {
  assert.equal(hover('px.scatter(df)', 'px'), 'help:px')
  assert.equal(hover('np.random.rand(3)', 'np'), 'help:np')
  // Среднее звено спрашивается вместе с корнем: `np.random` — это модуль.
  assert.equal(hover('np.random.rand(3)', 'random'), 'help:np.random')
  /*
   * А `df` псевдонимом не является: полной справки о нём не будет. Но с 21.09
   * о нём будет КОРОТКАЯ строка — тип и размер, — потому что про свою таблицу
   * человек спрашивает именно это.
   */
  assert.equal(hover('df.groupby("a").agg(sum)', 'df'), 'value:df')
  // Зато сам вызываемый метод спрашивается — как и раньше, по последнему звену.
  assert.equal(hover('df.groupby("a").agg(sum)', 'agg'), 'help:agg')
  assert.equal(hover('df.groupby("a")', 'groupby'), 'help:df.groupby')
})

test('атрибут пакета — справка, атрибут чужого объекта — короткая строка', () => {
  assert.equal(hover('x = np.pi', 'pi'), 'help:np.pi')
  // Цепочка атрибутов без вызова: `df.shape` это значение, и про него
  // отвечают одной строкой — «tuple · 2», а не страницей про кортежи.
  assert.equal(hover('rows = df.shape', 'shape'), 'value:df.shape')
  assert.equal(hover('rows = df.shape', 'df'), 'value:df')
  assert.equal(hover('score = model.coef_', 'coef_'), 'value:model.coef_')
})

/* ------------------------------------------------------------ что нельзя */

test('строки, f-строки и комментарии молчат целиком', () => {
  assert.equal(hover('px.scatter(df, x="area_sqm")', 'area_sqm'), 'нет:prose')
  // Имя внутри f-строки — это буквы: подставит его Python, а не человек.
  assert.equal(hover('s = f"{name} и дальше"', 'name'), 'нет:prose')
  assert.equal(hover('# print(df) — потом\nx = 1', 'print'), 'нет:prose')
  assert.equal(hover('x = 1  # про numpy\n', 'numpy'), 'нет:prose')
})

test('в списке аргументов: имя — короткая строка, ключ и литерал — ничего', () => {
  const line = 'px.scatter(apartments, x="area_sqm", hover_data=["offer_id", "metro"])'
  /*
   * Значение аргумента — это переменная, и про неё спрашивают «что это и
   * какого размера». Окна с документацией тут по-прежнему не будет: `value`
   * это одна строка.
   */
  assert.equal(hover(line, 'apartments'), 'value:apartments')
  // А ключ именованного аргумента объектом не является вовсе.
  assert.equal(hover(line, 'x='), 'нет:keyword-argument')
  assert.equal(hover(line, 'hover_data'), 'нет:keyword-argument')
  assert.equal(hover(line, 'offer_id'), 'нет:prose')
  // Переданная функция — тоже значение: строкой скажем, что это за функция.
  assert.equal(hover('df.apply(np.mean)', 'np'), 'value:np')
  assert.equal(hover('df.apply(np.mean)', 'mean'), 'value:np.mean')
})

test('объявления молчат, а присвоенное имя — значение', () => {
  // Имя, которое ещё только объявляют, объектом не является: справки о нём
  // нет ни в каком виде.
  assert.equal(hover('def helper(size):\n    return size', 'helper'), 'нет:definition')
  assert.equal(hover('def helper(size):\n    return size', 'size'), 'нет:parameter')
  assert.equal(hover('class Model(Base):\n    pass', 'Model'), 'нет:definition')
  /*
   * А слева от `=` и в `for … in` стоят обычные переменные: `apartments` слева
   * от присваивания — ровно та таблица, размер которой хотят увидеть.
   */
  assert.equal(hover('total = 1', 'total'), 'value:total')
  assert.equal(hover('for row in rows:\n    pass', 'row'), 'value:row')
  assert.equal(hover('for row in rows:\n    pass', 'rows'), 'value:rows')
})

test('ни числа, ни ключевые слова, ни пустое место', () => {
  assert.equal(hover('x = 42', '42'), 'нет:no-name')
  assert.equal(hover('for row in rows:\n    pass', 'for'), 'нет:no-name')
  assert.equal(hover('x = 1', ' ', 1), 'нет:no-name')
})

test('недописанный код не роняет разбор, а просто молчит', () => {
  /*
   * При наборе дерево почти всегда со следами ошибок, и это НОРМА: человек
   * печатает `px.scatter(` и в эту секунду наводит мышь. Правило обязано
   * отвечать, а не бросать.
   */
  for (const broken of ['px.scatter(', 'df.', 'import ', 'def f(', 'x = (', '@']) {
    const tree = parser.parse(broken)
    for (let at = 0; at <= broken.length; at++) {
      assert.doesNotThrow(() => hoverTarget({ tree, doc: broken, at, aliases: ALIASES }))
    }
  }
  // А имя вызываемого читается и в недописанной строке — скобка уже стоит.
  assert.equal(hover('px.scatter(', 'scatter'), 'help:px.scatter')
})

/* ------------------------------------------------------------- Shift+Tab */

test('каретка внутри скобок показывает сигнатуру того, что вызывают', () => {
  const line = 'px.scatter(apartments, x='
  // Ровно тот случай Jupyter: печатаю аргументы и спрашиваю, какие бывают.
  assert.equal(caret(line, line.length), 'help:px.scatter')
  /*
   * А на самом аргументе — его короткая строка: жест тот же, но каретка стоит
   * на переменной, и спрашивают про неё, а не про вызов.
   */
  assert.equal(caret(line, line.indexOf('apartments') + 3), 'value:apartments')
  // Вложенный вызов: подсказывают про того, чьи аргументы печатают.
  const nested = 'f(g(x, ))'
  assert.equal(caret(nested, nested.indexOf('x, ') + 3), 'help:g')
})

test('каретке разрешено всё, что разрешено наведению', () => {
  const line = 'px.scatter(df)'
  assert.equal(caret(line, line.indexOf('scatter') + 1), 'help:px.scatter')
  assert.equal(caret('import numpy as np', 8), 'help:numpy')
})

test('без охватывающего вызова каретка не находит ничего', () => {
  // Отступ без вызова — там Shift+Tab обязан остаться снятием отступа.
  assert.equal(caret('def f():\n    return 1', 14), 'нет:no-name')
  assert.equal(caret('    x = 1', 2), 'нет:no-name')
})

/* ------------------------------------------------------------ псевдонимы */

test('псевдонимы собираются по тексту тетради', () => {
  assert.deepEqual([...moduleAliases(['import numpy as np'])], ['np'])
  // `import a.b.c` связывает `a`, а не `c`.
  assert.deepEqual([...moduleAliases(['import matplotlib.pyplot'])], ['matplotlib'])
  assert.deepEqual([...moduleAliases(['import matplotlib.pyplot as plt'])], ['plt'])
  assert.deepEqual(
    [...moduleAliases(['import os, sys'])],
    ['os', 'sys'],
  )
  assert.deepEqual(
    [...moduleAliases(['from sklearn.linear_model import LinearRegression as LR, Ridge'])],
    ['LR', 'Ridge'],
  )
  // Импорт с отступом — внутри try или функции: в шапке тетради его нет.
  assert.deepEqual([...moduleAliases(['try:\n    import cv2\nexcept ImportError:\n    cv2 = None'])], [])
  // Ячейка на чужом языке — не Python.
  assert.deepEqual([...moduleAliases(['%%bash\nimport nothing'])], [])
  // Ячейки без слова import не разбираются вовсе.
  assert.deepEqual([...moduleAliases(['x = 1', 'print(x)'])], [])
  assert.deepEqual([...moduleAliases(['from x import *'])], [])
})
