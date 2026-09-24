/**
 * Parsing Python for go-to-definition.
 *
 * What is checked here is not "does it understand Python" — it does not and
 * must not — but exactly two things that decide whether the feature lies.
 *
 * FIRST: a definition that is not there is not invented. A `def` inside a
 * docstring, inside a comment, inside the body of another function and inside
 * a `%%bash` cell is not a definition; each of these cases is an ordinary
 * teaching notebook, not a contrived one.
 *
 * SECOND: the chain `df.head` does not become a jump. Its parse tree is the
 * same as that of `utils.helper`, and the only difference is what binds the
 * name on the left. Getting this wrong means confidently leading a person into
 * an unrelated class: the gesture worked, and there is no way to notice that
 * it lied.
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

/** Definition names with their kind, in the order they were found. */
const named = (code: string): string[] =>
  scanPython(code).defs.map((d) => `${d.kind}:${d.owner ? `${d.owner}.` : ''}${d.name}@${d.line}`)

/** The question at a position: the dotted chain. */
function ask(code: string, at: number): string | null {
  const q = questionAt(code, at)
  return q ? q.chain.join('.') : null
}

/** The position of the first occurrence of a substring plus an offset into it. */
const posOf = (code: string, needle: string, into = 1): number => code.indexOf(needle) + into

test('functions, classes and methods, with owner and line', () => {
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

test('a function body holds no module definitions', () => {
  // `helper = 1` in another function must not answer a click on `helper` in a
  // different cell: it is a local name, and it lives exactly until `return`.
  const code = ['def outer():', '    helper = 1', '    def inner():', '        pass', '    return inner'].join('\n')
  assert.deepEqual(named(code), ['def:outer@1'])
})

test('a def inside a docstring is not a definition', () => {
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

test('nor is a def in a comment or in a string', () => {
  const code = ['# def commented():', "note = 'def quoted(): pass'", 'def real(): pass'].join('\n')
  assert.deepEqual(named(code), ['assign:note@2', 'def:real@3'])
})

test('a cell in another language is skipped entirely', () => {
  // `%%writefile utils.py` with a module inside produced definitions whose jump
  // led to a cell where they do not exist.
  const shell = scanPython('%%bash\ndef not_python() { echo hi; }')
  assert.equal(shell.magic, true)
  assert.deepEqual(shell.defs, [])
  // But line magic does not get in the way of parsing: it is written as the first
  // line all the time.
  assert.deepEqual(named('%matplotlib inline\nimport numpy as np\ndef draw(): pass'), [
    'import:np@2',
    'def:draw@3',
  ])
})

test('top-level assignments, including tuple unpacking', () => {
  const code = ['X_train, X_test = split(df)', 'rate: float = 0.1', 'total += 1', 'if a == b:', '    pass'].join('\n')
  assert.deepEqual(named(code), ['assign:X_train@1', 'assign:X_test@1', 'assign:rate@2'])
})

test('imports in every form found in a notebook', () => {
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
      // `import os.path` puts `os` into scope, not `os.path`.
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

test('an import wrapped in parentheses loses no names', () => {
  const code = ['from eda_tools import (', '    describe_all,', '    missing_kinds as gaps,', ')'].join('\n')
  assert.deepEqual(
    scanPython(code).imports.map((i) => i.local),
    ['describe_all', 'gaps'],
  )
})

test('a signature wrapped in parentheses does not push local names out', () => {
  // The line `) -> X:` sits at zero indentation, and the line-by-line parse decided
  // the body had ended: local names and nested defs became MODULE names.
  const code = ['def loss(', '    a: int,', ') -> np.ndarray:', '    tmp = 1', '    def inner(): pass', '    return a'].join('\n')
  assert.deepEqual(named(code), ['def:loss@1'])
})

test('a class with wrapped bases does not lose its methods', () => {
  const code = ['class Tables(', '    Base,', '):', '    def head(self): pass'].join('\n')
  assert.deepEqual(named(code), ['class:Tables@1', 'def:Tables.head@4'])
})

test('a semicolon does not eat the second half of the line', () => {
  // It broke more than its own definitions: the header `import os; import sys`
  // disappeared entirely, and the chains of the whole notebook resolve through it.
  assert.deepEqual(named('import os; import sys'), ['import:os@1', 'import:sys@1'])
  assert.deepEqual(named('x = 1; y = 2'), ['assign:x@1', 'assign:y@1'])
})

test('names are bound by more than assignment', () => {
  // `for column in columns:` and `with open(p) as handle:` are half of a real
  // seminar, and the names in them are defined just as really as in `x = 1`.
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

test('an assignment inside a top-level if or for is a definition', () => {
  // The old "zero indentation only" rule lost everything inside a condition.
  assert.deepEqual(named('if ok:\n    column = 1\nelse:\n    column = 2'), [
    'assign:column@2',
    'assign:column@4',
  ])
})

test('dataclass fields declared by an annotation alone are found', () => {
  const code = ['@dataclass', 'class Tables:', '    train: pd.DataFrame', '    note: str = ""'].join('\n')
  assert.deepEqual(named(code), ['class:Tables@2', 'assign:Tables.train@3', 'assign:Tables.note@4'])
})

test('%%time is a wrapper around Python, not another language', () => {
  // Under `%%time` in a real notebook lies model training, names included.
  assert.deepEqual(named('%%time\ndef train_model(x): pass'), ['def:train_model@2'])
  assert.deepEqual(named('%%capture\nmodel = fit()'), ['assign:model@2'])
  // But `%%bash` is still another language.
  assert.equal(scanPython('%%bash\ndef not_python() { echo hi; }').magic, true)
})

test('the column points at the ALIAS, not inside the module name', () => {
  // `raw.indexOf('bpm')` found `bpm` inside `case_bpm` — six misses out of eight
  // in a real lecture header.
  const scan = scanPython('import case_bpm as bpm')
  assert.equal(scan.defs[0].column, 19)
  // An import wrapped in parentheses has no name on its first line at all.
  const wrapped = scanPython('from sklearn.ensemble import (\n    RandomForestClassifier,\n)')
  assert.equal(wrapped.defs[0].line, 2)
  assert.equal(wrapped.defs[0].column, 4)
})

test('a name inside an f-string is a name, and the letter f before it is not', () => {
  /*
   * `f"{cian_summary}"`: the prefix letter stayed a bare word, and a click on it
   * led to `def f(x)` from a neighbouring cell — the gesture worked and lied. The
   * contents of the substitution, on the contrary, were blanked out entirely,
   * although that is code, and in a real notebook half of the names live there.
   */
  const code = 'x = f"{cian_summary} строк"'
  assert.equal(ask(code, code.indexOf('f"') + 1), null, 'the literal letter became a name')
  assert.equal(ask(code, code.indexOf('cian_summary') + 1), 'cian_summary')
  // An ordinary string is still silent.
  assert.equal(ask('s = "helper(1)"', 7), null)
})

test('a keyword does not count as a name', () => {
  // `if`, `None`, `True` were underlined just like names and answered "not
  // found" — a promise of a jump where the language has nowhere to jump.
  for (const [line, word] of [
    ['if True:', 'if'],
    ['x = None', 'None'],
    ['for a in b:', 'for'],
    ['return x', 'return'],
    ['with open(p) as h:', 'with'],
  ] as const) {
    assert.equal(ask(line, line.indexOf(word) + 1), null, `${line} · ${word}`)
  }
  // But a name next to a keyword is still a name.
  assert.equal(ask('x = None', 1), 'x')
})

test('the name under the caret is the chain to the left, including the clicked link', () => {
  const code = 'out = df.head.values\n'
  assert.equal(ask(code, posOf(code, 'df')), 'df')
  assert.equal(ask(code, posOf(code, 'head')), 'df.head')
  assert.equal(ask(code, posOf(code, 'values')), 'df.head.values')
  assert.equal(ask(code, posOf(code, 'out')), 'out')
})

test('there is nothing to ask in a string or a comment', () => {
  assert.equal(ask("s = 'helper(1)'\n", posOf("s = 'helper(1)'\n", 'helper')), null)
  assert.equal(ask('# helper(1)\n', posOf('# helper(1)\n', 'helper')), null)
  const doc = ['def f():', '    """', '    helper()', '    """'].join('\n')
  assert.equal(ask(doc, posOf(doc, 'helper')), null)
  // But in the code under a docstring there is.
  const after = ['def f():', '    """док"""', '    helper()'].join('\n')
  assert.equal(ask(after, posOf(after, 'helper')), 'helper')
})

test('a number and empty space do not count as names', () => {
  assert.equal(ask('x = df.iloc[0]\n', 'x = df.iloc['.length), null)
  // An operator between names is not a name. But a caret RIGHT AGAINST the right
  // edge of a word counts as a name, and that is not a slip: that is how the mouse
  // lands at the end of a name.
  assert.equal(ask('a + b\n', 2), null)
  assert.equal(ask('a + b\n', 1), 'a')
})

test('a literal continued with a backslash does not breed definitions from its text', () => {
  // `sql = "select \\` continues on the next line, and the `def` in it is part of
  // the query text. The parser invented `def fake` and confidently led into it.
  const code = 'sql = "select \\\n    def fake(): pass"'
  assert.deepEqual(named(code), ['assign:sql@1'])
})

test('a chain that starts with an expression does not answer with a definition', () => {
  /*
   * `df[["a"]].head` and `f(x).head` break off at the bracket, and `head` looks
   * like a bare name — while it is a method of something not visible from here.
   * Without this a click found the first `def head` around and confidently led into it.
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
  // But a bare name and a chain from a module are still what they are.
  const plain = questionAt('plain_name(1)', 1)!
  assert.equal(plain.viaExpression, false)
  assert.deepEqual(resolveChain(plain, imports), { kind: 'name', name: 'plain_name' })
})

test('a chain from a module resolves, a chain from data does not', () => {
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
  // Here it is: `df` is bound by an assignment, not an import — so it is data.
  assert.deepEqual(chain('df.head'), { kind: 'opaque', owner: 'df', name: 'head' })
})

test('the middle of a chain is glued to the module', () => {
  const code = 'import pkg\n'
  const line = `${code}pkg.mod.helper`
  const target = resolveChain(questionAt(line, line.lastIndexOf('helper') + 1)!, scanPython(code).imports)
  assert.deepEqual(target, { kind: 'member', module: 'pkg.mod', level: 0, name: 'helper' })
})

test('a module turns into paths from the seminar folder root', () => {
  assert.deepEqual(modulePaths('eda_tools', 0, 'notebooks'), [
    'eda_tools.py',
    'eda_tools/__init__.py',
  ])
  assert.deepEqual(modulePaths('pkg.sub', 0, ''), ['pkg/sub.py', 'pkg/sub/__init__.py'])
  // A relative one, from the folder of the file it is written in.
  assert.deepEqual(modulePaths('util', 1, 'src/lab'), ['src/lab/util.py', 'src/lab/util/__init__.py'])
  assert.deepEqual(modulePaths('util', 2, 'src/lab'), ['src/util.py', 'src/util/__init__.py'])
  // `from . import util`: the module is empty, and the package is the folder itself.
  // The name `util` is looked up in its `__init__.py`, and if it is not there, as
  // the neighbouring module `src/util.py`; the second attempt is made by whoever is searching.
  assert.deepEqual(modulePaths('', 1, 'src'), ['src.py', 'src/__init__.py'])
  assert.deepEqual(modulePaths('', 0, 'src'), [])
})

test('of identical names the last one is shown, and the top level comes before a method', () => {
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
  assert.equal(top.line, 6, 'a redefinition below overrides the one above')
  assert.equal(top.owner, null, 'a bare name is not a method of another class')
  const method = pickDefinition(scan, 'fit', 'A') as Definition
  assert.equal(method.line, 2)
  assert.equal(pickDefinition(scan, 'missing'), null)
})

test('a real definition beats an import line', () => {
  // Otherwise the jump would lead to `from utils import f`, from which one has to
  // jump further anyway.
  const scan = scanPython(['from utils import f', 'def f(): pass'].join('\n'))
  assert.equal((pickDefinition(scan, 'f') as Definition).kind, 'def')
  const only = scanPython('from utils import f')
  assert.equal((pickDefinition(only, 'f') as Definition).kind, 'import')
})

test('the column points at the name, not at the start of the line', () => {
  const scan = scanPython('    def deep(): pass')
  assert.equal(scan.defs[0].column, 8)
  assert.equal(scan.defs[0].text, 'def deep(): pass')
})
