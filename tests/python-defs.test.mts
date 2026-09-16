/**
 * Разбор Python под переход к определению.
 *
 * Тут проверяется не «понимает ли оно Python» — оно не понимает и не должно, —
 * а ровно две вещи, от которых зависит, врёт фича или нет.
 *
 * ПЕРВАЯ: определение, которого нет, не выдумывается. `def` внутри docstring,
 * внутри комментария, внутри тела чужой функции и внутри ячейки `%%bash`
 * определением не является; каждый из этих случаев — обычная учебная тетрадь, а
 * не выдумка.
 *
 * ВТОРАЯ: цепочка `df.head` не становится переходом. Дерево разбора у неё такое
 * же, как у `utils.helper`, и разница только в том, чем связано имя слева.
 * Ошибиться здесь — значит уверенно увести человека в чужой класс: жест
 * сработал, и что он соврал, заметить нечем.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  modulePaths,
  pickDefinition,
  questionAt,
  resolveChain,
  scanPython,
  type Definition,
} from '../shared/python-defs.js'

/** Имена определений с их видом — в порядке, в котором они найдены. */
const named = (code: string): string[] =>
  scanPython(code).defs.map((d) => `${d.kind}:${d.owner ? `${d.owner}.` : ''}${d.name}@${d.line}`)

/** Вопрос по позиции: цепочка через точку. */
function ask(code: string, at: number): string | null {
  const q = questionAt(code, at)
  return q ? q.chain.join('.') : null
}

/** Позиция первого вхождения подстроки плюс сдвиг внутрь неё. */
const posOf = (code: string, needle: string, into = 1): number => code.indexOf(needle) + into

test('функции, классы и методы — с владельцем и строкой', () => {
  const code = [
    'import os',
    '',
    'def helper(df):',
    '    return df',
    '',
    'async def fetch(url):',
    '    ...',
    '',
    'class Model:',
    '    def fit(self, X):',
    '        return self',
    '',
    '    rate = 0.1',
    '',
    'def last():',
    '    pass',
  ].join('\n')
  assert.deepEqual(named(code), [
    'import:os@1',
    'def:helper@3',
    'def:fetch@6',
    'class:Model@9',
    'def:Model.fit@10',
    'assign:Model.rate@13',
    'def:last@15',
  ])
})

test('тело функции — не определения модуля', () => {
  // `helper = 1` в чужой функции не должно отвечать на клик по `helper`
  // в другой ячейке: это локальное имя, и живёт оно ровно до `return`.
  const code = ['def outer():', '    helper = 1', '    def inner():', '        pass', '    return inner'].join('\n')
  assert.deepEqual(named(code), ['def:outer@1'])
})

test('def внутри docstring определением не является', () => {
  const code = [
    'def real():',
    '    """Пример:',
    '',
    '    def fake():',
    '        pass',
    '    """',
    '    return 1',
    '',
    'x = 1',
  ].join('\n')
  assert.deepEqual(named(code), ['def:real@1', 'assign:x@9'])
})

test('def в комментарии и в строке — тоже нет', () => {
  const code = ['# def commented():', "note = 'def quoted(): pass'", 'def real(): pass'].join('\n')
  assert.deepEqual(named(code), ['assign:note@2', 'def:real@3'])
})

test('ячейка на чужом языке пропускается целиком', () => {
  // `%%writefile utils.py` с модулем внутри давал определения, к которым
  // переход вёл в ячейку, где их нет.
  const shell = scanPython('%%bash\ndef not_python() { echo hi; }')
  assert.equal(shell.magic, true)
  assert.deepEqual(shell.defs, [])
  // А строчная магия разбору не мешает: её пишут первой строкой сплошь и рядом.
  assert.deepEqual(named('%matplotlib inline\nimport numpy as np\ndef draw(): pass'), [
    'import:np@2',
    'def:draw@3',
  ])
})

test('присваивания верхнего уровня, включая разложение в кортеж', () => {
  const code = ['X_train, X_test = split(df)', 'rate: float = 0.1', 'total += 1', 'if a == b:', '    pass'].join('\n')
  assert.deepEqual(named(code), ['assign:X_train@1', 'assign:X_test@1', 'assign:rate@2'])
})

test('импорты во всех формах, что встречаются в тетради', () => {
  const code = [
    'import numpy as np',
    'import os.path',
    'import case_bpm, eda_tools as tools',
    'from sklearn.metrics import roc_auc_score as auc, f1_score',
    'from . import util',
    'from ..shared.tools import describe',
    'from plotstyle import *',
  ].join('\n')
  const { imports, stars } = scanPython(code)
  assert.deepEqual(
    imports.map((i) => `${i.local}=${i.module}${i.member ? `:${i.member}` : ''}${i.level ? `^${i.level}` : ''}`),
    [
      'np=numpy',
      // `import os.path` кладёт в область видимости `os`, а не `os.path`.
      'os=os',
      'case_bpm=case_bpm',
      'tools=eda_tools',
      'auc=sklearn.metrics:roc_auc_score',
      'f1_score=sklearn.metrics:f1_score',
      'util=:util^1',
      'describe=shared.tools:describe^2',
    ],
  )
  assert.deepEqual(stars, [{ module: 'plotstyle', level: 0 }])
})

test('импорт, перенесённый скобками, не теряет имён', () => {
  const code = ['from eda_tools import (', '    describe_all,', '    missing_kinds as gaps,', ')'].join('\n')
  assert.deepEqual(
    scanPython(code).imports.map((i) => i.local),
    ['describe_all', 'gaps'],
  )
})

test('подпись, перенесённая скобками, не выталкивает локальные имена наружу', () => {
  // Строка `) -> X:` стоит на нулевом отступе, и построчный разбор считал, что
  // тело кончилось: локальные имена и вложенные def становились именами МОДУЛЯ.
  const code = ['def loss(', '    a: int,', ') -> np.ndarray:', '    tmp = 1', '    def inner(): pass', '    return a'].join('\n')
  assert.deepEqual(named(code), ['def:loss@1'])
})

test('класс с перенесёнными базами не теряет своих методов', () => {
  const code = ['class Tables(', '    Base,', '):', '    def head(self): pass'].join('\n')
  assert.deepEqual(named(code), ['class:Tables@1', 'def:Tables.head@4'])
})

test('точка с запятой не съедает вторую половину строки', () => {
  // Ломало не только свои определения: шапка `import os; import sys` пропадала
  // целиком, а по ней разрешаются цепочки всей тетради.
  assert.deepEqual(named('import os; import sys'), ['import:os@1', 'import:sys@1'])
  assert.deepEqual(named('x = 1; y = 2'), ['assign:x@1', 'assign:y@1'])
})

test('имена связывает не только присваивание', () => {
  // `for column in columns:` и `with open(p) as handle:` — половина настоящего
  // семинара, и имена в них определены так же по-настоящему, как в `x = 1`.
  assert.deepEqual(named('for column in df.columns:\n    print(column)'), ['assign:column@1'])
  assert.deepEqual(named('with open(p) as handle:\n    text = handle.read()'), [
    'assign:handle@1',
    'assign:text@2',
  ])
  assert.deepEqual(named('try:\n    x = 1\nexcept ValueError as err:\n    pass'), [
    'assign:x@2',
    'assign:err@3',
  ])
})

test('присваивание внутри if и for на верхнем уровне — это определение', () => {
  // Прежнее правило «только нулевой отступ» теряло всё, что лежит в условии.
  assert.deepEqual(named('if ok:\n    column = 1\nelse:\n    column = 2'), [
    'assign:column@2',
    'assign:column@4',
  ])
})

test('поля dataclass объявлены одной аннотацией — и находятся', () => {
  const code = ['@dataclass', 'class Tables:', '    train: pd.DataFrame', '    note: str = ""'].join('\n')
  assert.deepEqual(named(code), ['class:Tables@2', 'assign:Tables.train@3', 'assign:Tables.note@4'])
})

test('%%time — это обёртка вокруг Python, а не другой язык', () => {
  // Под `%%time` в настоящей тетради лежит обучение модели вместе с именами.
  assert.deepEqual(named('%%time\ndef train_model(x): pass'), ['def:train_model@2'])
  assert.deepEqual(named('%%capture\nmodel = fit()'), ['assign:model@2'])
  // А `%%bash` по-прежнему чужой язык.
  assert.equal(scanPython('%%bash\ndef not_python() { echo hi; }').magic, true)
})

test('колонка указывает на ПСЕВДОНИМ, а не внутрь имени модуля', () => {
  // `raw.indexOf('bpm')` находил `bpm` внутри `case_bpm` — шесть промахов из
  // восьми в настоящей шапке лекции.
  const scan = scanPython('import case_bpm as bpm')
  assert.equal(scan.defs[0].column, 19)
  // У импорта, перенесённого скобками, имени на первой строке нет вовсе.
  const wrapped = scanPython('from sklearn.ensemble import (\n    RandomForestClassifier,\n)')
  assert.equal(wrapped.defs[0].line, 2)
  assert.equal(wrapped.defs[0].column, 4)
})

test('имя внутри f-строки — это имя, а буква f перед ней — нет', () => {
  /*
   * `f"{cian_summary}"`: буква префикса оставалась голым словом, и щелчок по
   * ней уводил в `def f(x)` из соседней ячейки — жест срабатывал и врал. А
   * содержимое подстановки, наоборот, замазывалось целиком, хотя это код, и
   * в настоящей тетради там живёт половина имён.
   */
  const code = 'x = f"{cian_summary} строк"'
  assert.equal(ask(code, code.indexOf('f"') + 1), null, 'буква литерала стала именем')
  assert.equal(ask(code, code.indexOf('cian_summary') + 1), 'cian_summary')
  // Обычная строка по-прежнему молчит.
  assert.equal(ask('s = "helper(1)"', 7), null)
})

test('ключевое слово именем не считается', () => {
  // `if`, `None`, `True` подчёркивались наравне с именами и отвечали «не
  // нашлось» — обещание перехода туда, где переходить некуда по языку.
  for (const [line, word] of [
    ['if True:', 'if'],
    ['x = None', 'None'],
    ['for a in b:', 'for'],
    ['return x', 'return'],
    ['with open(p) as h:', 'with'],
  ] as const) {
    assert.equal(ask(line, line.indexOf(word) + 1), null, `${line} · ${word}`)
  }
  // А имя рядом с ключевым словом — по-прежнему имя.
  assert.equal(ask('x = None', 1), 'x')
})

test('имя под кареткой — цепочка влево, включая щёлкнутое звено', () => {
  const code = 'out = df.head.values\n'
  assert.equal(ask(code, posOf(code, 'df')), 'df')
  assert.equal(ask(code, posOf(code, 'head')), 'df.head')
  assert.equal(ask(code, posOf(code, 'values')), 'df.head.values')
  assert.equal(ask(code, posOf(code, 'out')), 'out')
})

test('в строке и в комментарии спрашивать нечего', () => {
  assert.equal(ask("s = 'helper(1)'\n", posOf("s = 'helper(1)'\n", 'helper')), null)
  assert.equal(ask('# helper(1)\n', posOf('# helper(1)\n', 'helper')), null)
  const doc = ['def f():', '    """', '    helper()', '    """'].join('\n')
  assert.equal(ask(doc, posOf(doc, 'helper')), null)
  // А в коде под docstring — есть.
  const after = ['def f():', '    """док"""', '    helper()'].join('\n')
  assert.equal(ask(after, posOf(after, 'helper')), 'helper')
})

test('число и пустое место именем не считаются', () => {
  assert.equal(ask('x = df.iloc[0]\n', 'x = df.iloc['.length), null)
  // Знак между именами — не имя. А вот каретка ВПРИТЫК к правому краю слова
  // именем считается, и это не оговорка: так попадают в конец имени мышью.
  assert.equal(ask('a + b\n', 2), null)
  assert.equal(ask('a + b\n', 1), 'a')
})

test('литерал, продолженный слешем, не рождает определений из своего текста', () => {
  // `sql = "select \\` продолжается следующей строкой, и `def` в ней — часть
  // текста запроса. Разбор выдумывал `def fake` и уверенно вёл в него.
  const code = 'sql = "select \\\n    def fake(): pass"'
  assert.deepEqual(named(code), ['assign:sql@1'])
})

test('цепочка, начатая выражением, определением не отвечает', () => {
  /*
   * `df[["a"]].head` и `f(x).head` обрываются на скобке, и `head` выглядит
   * голым именем — а он метод чего-то, чего отсюда не видно. Без этого щелчок
   * находил первый попавшийся `def head` и уверенно уводил в него.
   */
  const imports = scanPython('import utils').imports
  for (const [line, word] of [
    ['apartments[["a"]].head(4)', 'head'],
    ['f(x).head(4)', 'head'],
    ['"abc".upper()', 'upper'],
  ] as const) {
    const q = questionAt(line, line.indexOf(word) + 1)!
    assert.equal(q.viaExpression, true, line)
    assert.deepEqual(resolveChain(q, imports), { kind: 'opaque', owner: '', name: word })
  }
  // А голое имя и цепочка от модуля — по-прежнему сами собой.
  const plain = questionAt('plain_name(1)', 1)!
  assert.equal(plain.viaExpression, false)
  assert.deepEqual(resolveChain(plain, imports), { kind: 'name', name: 'plain_name' })
})

test('цепочка от модуля разрешается, цепочка от данных — нет', () => {
  const code = ['import numpy as np', 'import eda_tools', 'from pkg import sub', 'df = load()'].join('\n')
  const { imports } = scanPython(code)
  const chain = (text: string) => {
    const line = `${code}\n${text}`
    return resolveChain(questionAt(line, line.lastIndexOf(text.split('.').pop()!) + 1)!, imports)
  }
  assert.deepEqual(chain('eda_tools.describe_all'), {
    kind: 'member',
    module: 'eda_tools',
    level: 0,
    name: 'describe_all',
  })
  assert.deepEqual(chain('np.array'), { kind: 'member', module: 'numpy', level: 0, name: 'array' })
  assert.deepEqual(chain('sub.helper'), { kind: 'member', module: 'pkg.sub', level: 0, name: 'helper' })
  // Вот оно: `df` связан присваиванием, а не импортом, — значит это данные.
  assert.deepEqual(chain('df.head'), { kind: 'opaque', owner: 'df', name: 'head' })
})

test('середина цепочки приклеивается к модулю', () => {
  const code = 'import pkg\n'
  const line = `${code}pkg.mod.helper`
  const target = resolveChain(questionAt(line, line.lastIndexOf('helper') + 1)!, scanPython(code).imports)
  assert.deepEqual(target, { kind: 'member', module: 'pkg.mod', level: 0, name: 'helper' })
})

test('модуль превращается в пути от корня папки семинара', () => {
  assert.deepEqual(modulePaths('eda_tools', 0, 'notebooks'), [
    'eda_tools.py',
    'eda_tools/__init__.py',
  ])
  assert.deepEqual(modulePaths('pkg.sub', 0, ''), ['pkg/sub.py', 'pkg/sub/__init__.py'])
  // Относительный — от папки того файла, где написан.
  assert.deepEqual(modulePaths('util', 1, 'src/lab'), ['src/lab/util.py', 'src/lab/util/__init__.py'])
  assert.deepEqual(modulePaths('util', 2, 'src/lab'), ['src/util.py', 'src/util/__init__.py'])
  // `from . import util` — модуль пустой, и пакетом оказывается сама папка.
  // Имя `util` ищется в её `__init__.py`, а если его там нет — как соседний
  // модуль `src/util.py`; вторую попытку делает уже тот, кто ищет.
  assert.deepEqual(modulePaths('', 1, 'src'), ['src.py', 'src/__init__.py'])
  assert.deepEqual(modulePaths('', 0, 'src'), [])
})

test('из одинаковых имён показывается последнее, и верхний уровень раньше метода', () => {
  const code = [
    'class A:',
    '    def fit(self): pass',
    '',
    'def fit(): pass',
    '',
    'def fit(x): pass',
  ].join('\n')
  const scan = scanPython(code)
  const top = pickDefinition(scan, 'fit') as Definition
  assert.equal(top.line, 6, 'переопределение ниже отменяет то, что выше')
  assert.equal(top.owner, null, 'голое имя — не метод чужого класса')
  const method = pickDefinition(scan, 'fit', 'A') as Definition
  assert.equal(method.line, 2)
  assert.equal(pickDefinition(scan, 'missing'), null)
})

test('настоящее определение важнее строки импорта', () => {
  // Иначе переход уводил бы на `from utils import f`, из которой всё равно
  // надо прыгать дальше.
  const scan = scanPython(['from utils import f', 'def f(): pass'].join('\n'))
  assert.equal((pickDefinition(scan, 'f') as Definition).kind, 'def')
  const only = scanPython('from utils import f')
  assert.equal((pickDefinition(only, 'f') as Definition).kind, 'import')
})

test('колонка указывает на имя, а не на начало строки', () => {
  const scan = scanPython('    def deep(): pass')
  assert.equal(scan.defs[0].column, 8)
  assert.equal(scan.defs[0].text, 'def deep(): pass')
})
