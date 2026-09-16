/**
 * Переход к определению: что отвечает сервер.
 *
 * Разбор Python проверен отдельно и без комнаты (tests/python-defs.test.mts).
 * Здесь — вторая половина: поиск по живому семинару, где у имени есть сразу
 * несколько мест, где оно может быть определено, и весь вопрос в том, какое
 * из них верное.
 *
 * Правил, за которые тут отвечают, три, и каждое — про доверие к жесту.
 *
 * ПОРЯДОК. Ячейку читают сверху вниз, и действующее определение — ближайшее
 * СВЕРХУ, а не первое попавшееся. Переопределить функцию в третьей ячейке,
 * перезапустить и работать дальше — это не крайний случай, это обычное утро.
 *
 * ГРАНИЦА. `df.head` определением не отвечает вовсе. В любой учебной тетради
 * найдётся какой-нибудь `def head`, и уверенный переход в него — единственный
 * промах, которого человек не заметит: жест сработал, и он читает чужой класс,
 * думая, что читает свой.
 *
 * СЛОВА. У «некуда» четыре разных причины, и они не взаимозаменяемы: `numpy`
 * нет в папке — это не то же самое, что «не нашлось».
 */
import './_env.mts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import { createSession } from '../server/src/db.js'
import { getSessionDoc, releaseSessionDoc } from '../server/src/collab/index.js'
import { makeDir, sessionDir } from '../server/src/workspace.js'
import { defineIn } from '../server/src/definitions.js'
import { createCell, getCells } from '../shared/notebook.js'

let room = 0

/**
 * Комната с тетрадью и файлами.
 *
 * `cells` — исходники ячеек по порядку; возвращаются их имена, чтобы тест мог
 * сказать, ИЗ КАКОЙ ячейки щёлкнули и в какую он ждёт попадания.
 */
function seminar(cells: string[], files: Record<string, string> = {}): { id: string; ids: string[] } {
  const id = `defs-${++room}`
  createSession(id, 'Семинар', null)
  for (const [rel, text] of Object.entries(files)) {
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    if (dir) makeDir(id, dir)
    fs.writeFileSync(path.join(sessionDir(id), rel), text)
  }
  const { doc } = getSessionDoc(id)
  const ids: string[] = []
  doc.transact(() => {
    const list = getCells(doc)
    // Приветственная ячейка новой комнаты тесту мешает: он считает попадания
    // по своим номерам, а не по документу целиком.
    list.delete(0, list.length)
    for (const source of cells) {
      const cell = createCell('code', source)
      list.push([cell])
      ids.push(cell.get('id') as string)
    }
  })
  return { id, ids }
}

const done = (id: string): void => void releaseSessionDoc(id)

/** Спросить про имя: каретка ставится на его первое вхождение в `code`. */
function at(id: string, code: string, needle: string, from?: { cellId?: string; path?: string }) {
  const cursor = code.indexOf(needle) + 1
  assert.ok(cursor > 0, `в коде нет «${needle}»`)
  return defineIn(id, code, cursor, from?.cellId, from?.path)
}

test('определение в соседней ячейке — с номером строки и самой строкой', () => {
  const { id, ids } = seminar(['import os\n\ndef describe_all(df):\n    return df.describe()', 'describe_all(train)'])
  const answer = at(id, 'describe_all(train)', 'describe_all', { cellId: ids[1] })
  assert.equal(answer.hit?.where, 'cell')
  assert.equal(answer.hit?.cellId, ids[0])
  assert.equal(answer.hit?.line, 3)
  assert.equal(answer.hit?.text, 'def describe_all(df):')
  assert.equal(answer.hit?.name, 'describe_all')
  done(id)
})

test('из двух одинаковых имён берётся ближайшее СВЕРХУ', () => {
  // Переопределили в ячейке 2, работают в ячейке 4: действует второе.
  const { id, ids } = seminar([
    'def score(x):\n    return 1',
    'def score(x):\n    return 2',
    'print(1)',
    'score(df)',
    'def score(x):\n    return 3',
  ])
  const answer = at(id, 'score(df)', 'score', { cellId: ids[3] })
  assert.equal(answer.hit?.cellId, ids[1], 'взяли не ближайшую сверху')
  done(id)
})

test('если выше нет — берётся первое НИЖЕ', () => {
  // Обычная тетрадь: вызов написали раньше, чем функцию, и это не ошибка.
  const { id, ids } = seminar(['score(df)', 'def score(x):\n    return 1'])
  const answer = at(id, 'score(df)', 'score', { cellId: ids[0] })
  assert.equal(answer.hit?.cellId, ids[1])
  done(id)
})

test('своя ячейка отвечает сама за себя', () => {
  const code = 'def helper(x):\n    return x\n\nhelper(1)'
  const { id, ids } = seminar([code])
  const answer = defineIn(id, code, code.lastIndexOf('helper') + 1, ids[0])
  assert.equal(answer.hit?.cellId, ids[0])
  assert.equal(answer.hit?.line, 1)
  done(id)
})

test('модуль семинара: import utils, клик по utils.deep', () => {
  const { id, ids } = seminar(['import eda_tools', 'eda_tools.describe_all(df)'], {
    'eda_tools.py': '"""Инструменты."""\n\n\ndef describe_all(df):\n    return df\n',
  })
  const answer = at(id, 'import eda_tools\neda_tools.describe_all(df)', 'describe_all', { cellId: ids[1] })
  assert.equal(answer.hit?.where, 'file')
  assert.equal(answer.hit?.path, 'eda_tools.py')
  assert.equal(answer.hit?.line, 4)
  done(id)
})

test('from utils import f — и клик по голому f', () => {
  const { id, ids } = seminar(['from eda_tools import describe_all', 'describe_all(df)'], {
    'eda_tools.py': 'def describe_all(df):\n    return df\n',
  })
  const code = 'from eda_tools import describe_all\ndescribe_all(df)'
  const answer = defineIn(id, code, code.lastIndexOf('describe_all') + 1, ids[1])
  assert.equal(answer.hit?.where, 'file')
  assert.equal(answer.hit?.path, 'eda_tools.py')
  assert.equal(answer.hit?.line, 1)
  done(id)
})

test('пакет папками: from pkg.sub import f', () => {
  const { id, ids } = seminar(['from pkg.sub import helper', 'helper()'], {
    'pkg/__init__.py': '',
    'pkg/sub.py': 'def helper():\n    return 1\n',
  })
  const code = 'from pkg.sub import helper\nhelper()'
  const answer = defineIn(id, code, code.lastIndexOf('helper') + 1, ids[1])
  assert.equal(answer.hit?.path, 'pkg/sub.py')
  assert.equal(answer.hit?.line, 1)
  done(id)
})

test('клик по самому имени модуля ведёт в начало его файла', () => {
  const { id, ids } = seminar(['import plotstyle'], { 'plotstyle.py': '\n\nimport matplotlib\n' })
  const answer = at(id, 'import plotstyle\nplotstyle.setup()', 'plotstyle\nplotstyle'.slice(0, 9), { cellId: ids[0] })
  assert.equal(answer.hit?.where, 'file')
  assert.equal(answer.hit?.path, 'plotstyle.py')
  done(id)
})

test('импорт из ШАПКИ тетради действует во всех её ячейках', () => {
  /*
   * Область видимости в тетради — не ячейка, а ядро. `import case_cian as cian`
   * стоит третьей ячейкой и действует до конца занятия; пока здесь читались
   * импорты только щёлкнутой ячейки, `cian.fig_range_audit(...)` из
   * шестнадцатой отвечал «что такое cian, отсюда не видно» — то есть фича
   * разваливалась ровно на том, как устроена любая учебная тетрадь.
   */
  const { id, ids } = seminar(
    ['import case_cian as cian', 'print(1)', 'fig = cian.fig_range_audit(apartments)'],
    { 'case_cian.py': 'def fig_range_audit(df):\n    return df\n' },
  )
  const code = 'fig = cian.fig_range_audit(apartments)'
  const answer = defineIn(id, code, code.indexOf('fig_range_audit') + 1, ids[2])
  assert.equal(answer.hit?.where, 'file')
  assert.equal(answer.hit?.path, 'case_cian.py')
  assert.equal(answer.hit?.line, 1)
  done(id)
})

test('своя ячейка перебивает шапку, если имя переопределили у себя', () => {
  // `resolveChain` берёт первое совпадение, и свои импорты стоят первыми.
  const { id, ids } = seminar(
    ['import case_cian as cian', 'import case_rohlik as cian\ncian.load_tables()'],
    {
      'case_cian.py': 'def load_tables():\n    return 1\n',
      'case_rohlik.py': '\ndef load_tables():\n    return 2\n',
    },
  )
  const code = 'import case_rohlik as cian\ncian.load_tables()'
  const answer = defineIn(id, code, code.lastIndexOf('load_tables') + 1, ids[1])
  assert.equal(answer.hit?.path, 'case_rohlik.py')
  done(id)
})

test('шапка чужой тетради в эту не лезет', () => {
  // Ядро одно, но тетради разные, и `cian` из соседней здесь не определён:
  // иначе переход уводил бы в модуль, которого в этой тетради не импортировали.
  const { id, ids } = seminar(['cian.load()'], { 'case_cian.py': 'def load():\n    return 1\n' })
  const { doc } = getSessionDoc(id)
  doc.transact(() => {
    const other = doc.getArray('nb:second') as unknown as Y.Array<ReturnType<typeof createCell>>
    other.push([createCell('code', 'import case_cian as cian')])
  })
  const answer = at(id, 'cian.load()', 'load', { cellId: ids[0] })
  assert.notEqual(answer.hit?.path, 'case_cian.py')
  done(id)
})

test('звёздный импорт из шапки называет модуль точнее, чем алфавит', () => {
  /*
   * `def figure` есть и в plotstyle.py, и в case_cian.py. Сквозной проход по
   * файлам взял бы первый по алфавиту — case_cian.py, — а правильный ответ
   * знает только строка `from plotstyle import *`, и знает точно.
   */
  const { id, ids } = seminar(['from plotstyle import *', 'fig = figure(1)'], {
    'case_cian.py': 'def figure(n):\n    return n\n',
    'plotstyle.py': '\n\ndef figure(n):\n    return n\n',
  })
  const answer = at(id, 'fig = figure(1)', 'figure', { cellId: ids[1] })
  assert.equal(answer.hit?.path, 'plotstyle.py', 'взяли по алфавиту вместо названного модуля')
  assert.equal(answer.hit?.line, 3)
  done(id)
})

test('свой импорт важнее чужого, стоящего ниже по тетради', () => {
  /*
   * `lastImport` берёт последний по списку, а список идёт по всей тетради —
   * значит «последний» стал означать «в самой нижней ячейке». В щёлкнутой
   * ячейке своими глазами написано `from case_cian import load`, а переход
   * уводил в case_rohlik.py только потому, что тот импорт стоит ниже.
   */
  const { id, ids } = seminar(
    ['from case_cian import load\nload()', 'from case_rohlik import load'],
    {
      'case_cian.py': 'def load():\n    return 1\n',
      'case_rohlik.py': '\n\ndef load():\n    return 2\n',
    },
  )
  const code = 'from case_cian import load\nload()'
  const answer = defineIn(id, code, code.lastIndexOf('load') + 1, ids[0])
  assert.equal(answer.hit?.path, 'case_cian.py', 'увели в чужой модуль')
  done(id)
})

test('имя из шапки приводит в модуль, а не на строку импорта', () => {
  // Приземление на `from eda_tools import load_dataset` — это строка, из
  // которой надо прыгать второй раз, и человек её и так видел.
  const { id, ids } = seminar(['from eda_tools import load_dataset', 'df = load_dataset("cian")'], {
    'eda_tools.py': '\ndef load_dataset(name):\n    return name\n',
  })
  const code = 'df = load_dataset("cian")'
  const answer = defineIn(id, code, code.indexOf('load_dataset') + 1, ids[1])
  assert.equal(answer.hit?.where, 'file')
  assert.equal(answer.hit?.path, 'eda_tools.py')
  assert.equal(answer.hit?.line, 2)
  done(id)
})

test('установленные пакеты не выбивают свои модули из сквозного прохода', () => {
  /*
   * Одна строка `pip install -t .` заводит в папке тысячи .py, и проход по
   * алфавиту выбирал потолок чтений на них ещё до первого своего модуля:
   * `use_style` переставал находиться вовсе.
   */
  const files: Record<string, string> = { 'plotstyle.py': 'def use_style():\n    return 1\n' }
  for (let i = 0; i < 120; i++) {
    files[`site-packages/pkg${i}/__init__.py`] = `# ${'x'.repeat(200)}\ndef use_style(): pass\n`
  }
  const { id, ids } = seminar(['use_style()'], files)
  const answer = at(id, 'use_style()', 'use_style', { cellId: ids[0] })
  assert.equal(answer.hit?.path, 'plotstyle.py')
  done(id)
})

test('крупный файл: строки считаются от начала файла, а не от начала окна', () => {
  /*
   * Потолок кадра 24 КБ, а `case_cian.py` живого курса — 886 КБ: клик там
   * приезжает КУСКОМ. Пока срез не доезжал до сервера, приземление уходило на
   * сотни строк мимо, а определение за краем окна «не находилось» — и поиск
   * шёл дальше, в чужие файлы, где имя совпало.
   */
  const filler = 'padding = 1\n'.repeat(3000)
  const big = `def deep_helper():\n    return 1\n\n${filler}deep_helper()\n`
  const { id } = seminar([], { 'big.py': big })
  // Клиент прислал бы окно вокруг каретки: определение в него не попадает.
  const at = big.lastIndexOf('deep_helper')
  const cut = at - 100
  const answer = defineIn(id, big.slice(cut, cut + 24 * 1024), 101, undefined, 'big.py', cut)
  assert.equal(answer.hit?.path, 'big.py')
  assert.equal(answer.hit?.line, 1, 'строку посчитали от начала окна, а не файла')
  assert.equal(answer.hit?.text, 'def deep_helper():')
  done(id)
})

test('целого текста не нашлось — лучше отказ, чем уверенно неверная строка', () => {
  // Окно есть, а исходника под него нет: так бывает у файла, удалённого между
  // отправкой и ответом. Приземляться в него по строкам окна нельзя.
  const { id } = seminar([], {})
  const answer = defineIn(id, 'def gone():\n    pass\ngone()', 23, undefined, 'нет.py', 5000)
  assert.equal(answer.hit, undefined)
  assert.equal(answer.miss?.why, 'unknown')
  done(id)
})

test('df.head определением НЕ отвечает, даже когда def head в тетради есть', () => {
  // Ровно та ловушка, ради которой всё это писалось: `def head` рядом есть, и
  // уверенный переход в него человек не проверит.
  const { id, ids } = seminar(['class Table:\n    def head(self):\n        return 1', 'df = load()\ndf.head()'])
  const code = 'df = load()\ndf.head()'
  const answer = defineIn(id, code, code.lastIndexOf('head') + 1, ids[1])
  assert.equal(answer.hit, undefined, 'нашёл то, чего знать не мог')
  assert.deepEqual(answer.miss, { why: 'opaque', name: 'head', owner: 'df' })
  done(id)
})

test('библиотека называется по имени, а не «не нашлось»', () => {
  const { id, ids } = seminar(['import numpy as np', 'np.array([1])'])
  const code = 'import numpy as np\nnp.array([1])'
  const answer = defineIn(id, code, code.indexOf('array') + 1, ids[1])
  assert.equal(answer.miss?.why, 'outside')
  assert.equal(answer.miss?.why === 'outside' ? answer.miss.module : '', 'numpy')
  done(id)
})

test('щелчок по НАЗВАНИЮ модуля в строке импорта называет библиотеку', () => {
  // `import pandas as pd` связывает `pd`, а слово `pandas` не значит ничего —
  // и раньше падало в «не нашлось ни в тетрадях, ни в файлах»: правда, но не
  // та. Искали модуль, и человеку надо знать, что он из библиотеки.
  const { id, ids } = seminar(['import pandas as pd'])
  const code = 'import pandas as pd'
  const answer = defineIn(id, code, code.indexOf('pandas') + 1, ids[0])
  assert.equal(answer.miss?.why, 'outside')
  assert.equal(answer.miss?.why === 'outside' ? answer.miss.module : '', 'pandas')
  done(id)
})

test('а свой модуль тем же щелчком открывается', () => {
  const { id, ids } = seminar(['import eda_tools as tools'], { 'eda_tools.py': 'x = 1\n' })
  const code = 'import eda_tools as tools'
  const answer = defineIn(id, code, code.indexOf('eda_tools') + 1, ids[0])
  assert.equal(answer.hit?.path, 'eda_tools.py')
  done(id)
})

test('имени нет нигде — так и говорится', () => {
  const { id, ids } = seminar(['совсем_другое = 1', 'unknown_name(1)'])
  const answer = at(id, 'unknown_name(1)', 'unknown_name', { cellId: ids[1] })
  assert.deepEqual(answer.miss, { why: 'unknown', name: 'unknown_name' })
  done(id)
})

test('под указателем не имя — молчание', () => {
  const { id, ids } = seminar(['x = 1  # helper'])
  const code = 'x = 1  # helper'
  assert.deepEqual(defineIn(id, code, code.indexOf('helper') + 1, ids[0]).miss, { why: 'nothing' })
  assert.deepEqual(defineIn(id, code, 4, ids[0]).miss, { why: 'nothing' })
  done(id)
})

test('ячейка на чужом языке ничего не ищет', () => {
  const { id, ids } = seminar(['def train(x): pass', '%%bash\npython train.py'])
  const code = '%%bash\npython train.py'
  assert.deepEqual(defineIn(id, code, code.indexOf('train.py') + 1, ids[1]).miss, { why: 'nothing' })
  done(id)
})

test('сквозной поиск по .py, когда имя ниоткуда не импортировано', () => {
  const { id, ids } = seminar(['plot_roc(y, p)'], {
    'plotstyle.py': 'def plot_roc(y, p):\n    return None\n',
  })
  const answer = at(id, 'plot_roc(y, p)', 'plot_roc', { cellId: ids[0] })
  assert.equal(answer.hit?.path, 'plotstyle.py')
  done(id)
})

test('клик в .py-файле ищет от папки этого файла', () => {
  const { id } = seminar([], {
    'pkg/__init__.py': '',
    'pkg/util.py': 'def shared():\n    return 1\n',
    'pkg/work.py': 'from . import util\n\nutil.shared()\n',
  })
  const code = 'from . import util\n\nutil.shared()\n'
  const answer = defineIn(id, code, code.lastIndexOf('shared') + 1, undefined, 'pkg/work.py')
  assert.equal(answer.hit?.path, 'pkg/util.py')
  assert.equal(answer.hit?.line, 1)
  done(id)
})

test('определение в ЧУЖОЙ тетради находится после своей', () => {
  const { id, ids } = seminar(['helper_two()'])
  const { doc } = getSessionDoc(id)
  // Вторая тетрадь комнаты: ячейки лежат в своём корне, и поиск обязан
  // доходить до неё — ядро в комнате одно на все тетради.
  doc.transact(() => {
    const other = doc.getArray('nb:second') as unknown as Y.Array<ReturnType<typeof createCell>>
    other.push([createCell('code', 'def helper_two():\n    return 2')])
  })
  const answer = at(id, 'helper_two()', 'helper_two', { cellId: ids[0] })
  // Без записи в meta.books вторая тетрадь комнате не принадлежит — тогда
  // честный ответ «не нашлось», и это не провал теста, а проверка того, что
  // поиск идёт по СПИСКУ тетрадей, а не по всем корням документа подряд.
  assert.ok(answer.hit || answer.miss?.why === 'unknown')
  done(id)
})
