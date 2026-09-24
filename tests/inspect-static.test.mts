/**
 * The second help path: a signature from the SOURCES, when the kernel has
 * nothing yet.
 *
 * `inspect_request` answers from the namespace, and a notebook is opened top
 * to bottom: until the `import seaborn as sns` cell has been run, the live
 * kernel knows nothing about `sns.lmplot` and answers "not found". In class
 * exactly this looked like "help does not always appear".
 *
 * Everything that breaks silently on this path is checked here:
 *   · the import header — the only thing jedi learns from that `sns` is
 *     seaborn; built wrong, it turns the answer into silence, and that cannot
 *     be told from the screen;
 *   · the question that goes to the kernel: the caret position after the
 *     glued-on header (off by a line, jedi would parse the neighbouring
 *     name), the hidden module and `user_expressions`, the limits and the
 *     alarm;
 *   · parsing the answer: telling "not found" from "there was no answer at
 *     all" matters — the first is an ordinary outcome, the second is our
 *     trouble.
 *
 * Real Python is not run here: the parsing itself was checked on a live
 * `colloq-kernel:base` kernel (jedi 0.20, seaborn 0.13.2), and the suite has
 * to run on a machine without docker.
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
import { setLocaleResolver } from '../shared/i18n.js'

/* ------------------------------------------------------------ import header */

test('the header gets the imports of the cells above — in the same order', () => {
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

test('the header does not get what would break parsing of the WHOLE header', () => {
  const header = importHeader([
    // An indent means an import inside a try/function: in the header that is
    // an IndentationError, after which jedi will not parse a single name.
    'try:\n    import cv2\nexcept ImportError:\n    cv2 = None',
    // A line continuation: its tail will not be in the header.
    'from typing import (\n    Any,\n    Dict,\n)',
    'import numpy as np \\',
    // Not Python at all.
    '%%bash\nimport nothing',
    'import numpy as np',
  ])
  assert.deepEqual(header.split('\n'), ['import numpy as np'])
})

test('repeats are dropped: one line appears in half of the course cells', () => {
  const header = importHeader(['import pandas as pd', 'import pandas as pd\nimport numpy as np'])
  assert.deepEqual(header.split('\n'), ['import pandas as pd', 'import numpy as np'])
})

test('the header does not grow without limit — the frame to the kernel is not elastic', () => {
  const many = Array.from({ length: 400 }, (_, i) => `import mod_${i}`)
  const header = importHeader([many.join('\n')])
  assert.ok(header.split('\n').length <= 60, `${header.split('\n').length} lines went into the header`)
  assert.ok(header.length <= 4 * 1024)
})

test('cells without imports cost nothing and bring nothing', () => {
  assert.equal(importHeader(['x = 1', 'print(x)']), '')
  assert.equal(importHeader([]), '')
})

/* --------------------------------------------------------------- question */

test('the caret moves by exactly as many lines as the header has', () => {
  const header = importHeader(['import seaborn as sns'])
  const code = 'fig = None\nsns.lmplot'
  const source = inspectStaticSource({ code, cursor: code.length, header })
  /*
   * The header is one line, the cell two: the name stands on the THIRD line of
   * the glued text and in the tenth column. Off by a line, jedi would parse
   * the neighbouring name and confidently answer about the wrong thing.
   */
  assert.match(source, /\.look\(.*, 3, 10, "sns\.lmplot", /)
  assert.match(source, /"import seaborn as sns\\nfig = None\\nsns\.lmplot"/)
})

test('without a header the question is the same, just without the shift', () => {
  const source = inspectStaticSource({ code: 'sns.lmplot', cursor: 10 })
  assert.match(source, /\.look\("sns\.lmplot", 1, 10, "sns\.lmplot", /)
})

test('the name under the caret is taken as a chain — otherwise the signature has the wrong name', () => {
  assert.equal(nameChainAt('sns.lmplot', 10), 'sns.lmplot')
  assert.equal(nameChainAt('df.head', 5), 'df.he')
  assert.equal(nameChainAt('x = 1\ndf.head', 13), 'df.head')
  assert.equal(nameChainAt('print(', 6), '')
})

test("the question leaves nothing in the student's namespace and prints nothing", () => {
  const source = inspectStaticSource({ code: 'x', cursor: 1 })
  // The module is hidden in sys.modules; not a single name appears in globals().
  assert.match(source, new RegExp(`sys'\\)\\.modules\\[\\"${INSPECT_MODULE}\\"\\]`))
  assert.doesNotMatch(source, /^import /m, "the source bound a name in the student's namespace")
  // Installation is idempotent: a second question does not recompile the module.
  assert.match(source, /if getattr\(__import__\('sys'\)\.modules\.get\(/)
  // The answer travels as an expression — with silent, nothing at all
  // arrives on IOPUB.
  assert.match(INSPECT_REPORT_EXPR, new RegExp(`modules\\['${INSPECT_MODULE}'\\]\\.report`))
})

test('the parse has an alarm and an answer ceiling, and both go to the kernel', () => {
  const source = inspectStaticSource({ code: 'x', cursor: 1 })
  assert.match(source, new RegExp(`, ${INSPECT_BUDGET_SEC}, ${INSPECT_LIMIT_BYTES}\\)$`))
  // It has to be cut off FROM INSIDE: a server that stopped waiting does not
  // free the kernel.
  assert.match(source, /signal\.setitimer\(signal\.ITIMER_REAL, budget\)/)
  assert.match(source, /signal\.setitimer\(signal\.ITIMER_REAL, 0\)/)
  /*
   * Two and a half seconds is a measured ceiling, not a round number: the
   * first pandas parse on a cold container costs ~1.5 s, and the previous one
   * and a half seconds cut exactly that (measured on 20 Sep 2026:
   * pd.DataFrame — 1946 ms). More than three is not allowed: for that time
   * the kernel's shell is busy, and Run waits.
   */
  assert.ok(INSPECT_BUDGET_SEC >= 2 && INSPECT_BUDGET_SEC <= 3)
})

test('a module without documentation shows at least WHAT it is', () => {
  const source = inspectStaticSource({ code: 'pd', cursor: 2 })
  /*
   * pandas has no docstring in its `__init__.py` at all, while numpy has one —
   * and until 20 Sep 2026 that meant hovering over `np` answered with a page,
   * and over the neighbouring `pd` with "nothing to say". A difference a
   * person cannot explain. Now such a name shows its kind and its full name,
   * in the same field IPython itself uses for that.
   */
  assert.match(source, /String form: </)
  assert.match(source, /full_name/)
  // And the best of what was found is chosen: for pd.read_csv jedi returns
  // five overloads from the .pyi, and not every one has documentation.
  assert.match(source, /rank = 2 if \(sig and doc\.strip\(\)\)/)
})

test('custom budget and ceiling values arrive as they are', () => {
  const source = inspectStaticSource({ code: 'x', cursor: 1, budgetSec: 0.25, limitBytes: 512 })
  assert.match(source, /, 0\.25, 512\)$/)
})

/* ------------------------------------------------------------- module */

/**
 * A module is answered for by its PACKAGE, not by the object.
 *
 * "module · <module pandas>", "module · <module seaborn>" — that is what the
 * teacher saw on 21 Sep 2026. pandas assembles its module docstring by
 * assigning `__doc__` at runtime, seaborn has none at all, and IPython says
 * the same about both: the kind, the memory address and `<no docstring>`.
 * The name the package is installed under, its version, description and
 * documentation link lie next to it on disk (dist-info) and are read WITHOUT
 * an import — a mouse hover has no right to execute someone else's code.
 */
test('a question about a live module imports nothing and evaluates nothing', () => {
  const source = inspectFactsSource('plt')
  // The student's namespace goes along as an argument: the module is already
  // there.
  assert.match(source, /\.facts\(globals\(\), "plt", \d+\)$/)
  // Neither eval nor an import of the user's module: only dots and getattr.
  assert.match(source, /getattr\(value, step, None\)/)
  assert.doesNotMatch(source, /\beval\(/)
  assert.doesNotMatch(source, /__import__\((?!'sys'|'types')/)
  // The "module → distribution" map is computed once per kernel: 84 ms on the
  // image.
  assert.match(source, /_dists = md\.packages_distributions\(\)/)
  assert.match(source, /if _dists is None:/)
})

test('the package sections go ON TOP, and the IPython header is removed', () => {
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
   * The client parser — rightly — treats a repeated `Type:` as part of the
   * open section: the documentation link would turn into
   * "https://… Type: module". The leading header is removed entirely.
   */
  assert.equal((merged.match(/^Type:/gm) ?? []).length, 1)
  assert.doesNotMatch(merged, /String form:/)
  assert.doesNotMatch(merged, /site-packages/)
  // And the documentation (whatever there is) stays in place.
  assert.match(merged, /Docstring:/)
})

test('the same line INSIDE the documentation stays text', () => {
  const live = ['Type: module', 'Docstring:', 'Пример:', 'File: example.csv', 'и дальше'].join('\n')
  const merged = withModuleFacts(live, 'Module: mytool\nType: module')
  assert.match(merged, /File: example\.csv/)
  assert.match(merged, /и дальше/)
})

test('nothing to add — the answer goes out as it is', () => {
  const live = 'Type: module\nDocstring:\nOS routines.'
  assert.equal(withModuleFacts(live, ''), live)
  assert.equal(withModuleFacts(live, '   '), live)
})

test('"this is a module" is recognised by the same word the client sees', () => {
  assert.equal(looksLikeModule('Type:        module'), true)
  assert.equal(looksLikeModule('Signature: f(x)\nType: function'), false)
  // The word in the middle of documentation is not caught: a heading stands
  // at the start of a line.
  assert.equal(looksLikeModule('Docstring:\n  Type: module (в примере)'), false)
})

/* ---------------------------------------------------------------- answer */

test('the kernel answer is read both from user_expressions and as a bare string', () => {
  const text = 'Signature:\nsns.lmplot(data)\nType: function'
  const json = JSON.stringify({ found: true, text })
  assert.deepEqual(parseStaticInspect(json), { found: true, text, why: null })
  assert.deepEqual(
    parseStaticInspect({ status: 'ok', data: { 'text/plain': json } }),
    { found: true, text, why: null },
  )
})

test('"not found" and "there was no answer" are different answers', () => {
  // Not found: an ordinary outcome, and it has its own reason.
  assert.deepEqual(parseStaticInspect(JSON.stringify({ found: false, why: 'nothing' })), {
    found: false,
    text: null,
    why: 'nothing',
  })
  assert.equal(parseStaticInspect(JSON.stringify({ found: false, why: 'no-jedi' })).why, 'no-jedi')
  assert.equal(parseStaticInspect(JSON.stringify({ found: false, why: 'timeout' })).why, 'timeout')

  // There was no answer at all: the module did not install, the expression
  // was not evaluated.
  assert.equal(parseStaticInspect(null), null)
  assert.equal(parseStaticInspect('None'), null)
  assert.equal(parseStaticInspect('не json'), null)
  assert.equal(parseStaticInspect({ status: 'error', data: {} }), null)
  assert.equal(parseStaticInspect({ status: 'ok', data: {} }), null)
})

test('found without text means not found', () => {
  assert.equal(parseStaticInspect(JSON.stringify({ found: true, text: '' }))?.found, false)
  assert.equal(parseStaticInspect(JSON.stringify({ found: true }))?.found, false)
})

/* ------------------------------------------------------- the line about a value */

/**
 * "At least the variable's data type, a quick type and the dimensions" — the
 * owner's request of 21 Sep 2026; its second half is no less important: "it
 * also added a whole wagon of more detailed text there, that is not very
 * cool".
 *
 * What is checked here breaks quietly and expensively: the answer must be
 * O(1) and WITHOUT side effects. For a database cursor, a generator and a
 * lazy collection, `len()` and `repr()` can cost a minute of work or move
 * them along — and a mouse hover has the right to neither.
 *
 * It runs on real python3: the rule lives in Python, and checking it with a
 * fake would mean checking our own ideas about it.
 */
const PYTHON = (() => {
  const probe = spawnSync('python3', ['-c', 'print(1)'], { encoding: 'utf8' })
  return probe.status === 0 ? 'python3' : null
})()

const HAS = (name: string) =>
  PYTHON !== null &&
  spawnSync(PYTHON, ['-c', `import ${name}`], { encoding: 'utf8' }).status === 0

/** Run `setup`, ask about `expr` and return the parsed answer. */
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

test('a question about a value executes nothing and imports nothing', () => {
  const source = inspectBriefSource('df.shape')
  assert.match(source, /\.brief\(globals\(\), "df\.shape"\)$/)
  assert.match(source, /getattr\(value, step, missing\)/)
  assert.doesNotMatch(source, /\beval\(/)
  // An unfamiliar object is asked no question except its type: neither len
  // nor repr — see the section header.
  assert.match(source, /Unfamiliar: only the type name/)
})

test('built-in types: size, value, element type', { skip: PYTHON ? false : 'no python3' }, () => {
  assert.deepEqual(briefOf('n = 42', 'n'), { type: 'int', value: '42' })
  assert.deepEqual(briefOf('flag = True', 'flag'), { type: 'bool', value: 'True' })
  assert.deepEqual(briefOf('nothing = None', 'nothing'), { type: 'NoneType', value: 'None' })
  assert.deepEqual(briefOf('names = ["a", "b", "c"]', 'names'), { type: 'list[str]', dims: '3' })
  // A mixed list does not boast an element type.
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

test('a long value is cut, not shown whole', { skip: PYTHON ? false : 'no python3' }, () => {
  const long = briefOf('s = "щ" * 500', 's')
  assert.equal(long?.dims, '500')
  assert.ok((long?.value?.length ?? 0) <= 41, `a value of length ${long?.value?.length}`)
  assert.match(long?.value ?? '', /…$/)
})

test('a function, a class and a module are named in one line', { skip: PYTHON ? false : 'no python3' }, () => {
  assert.deepEqual(briefOf('def helper(a, b=1): pass', 'helper'), {
    type: 'function',
    note: 'helper(a, b=1)',
  })
  assert.deepEqual(briefOf('class Thing: pass', 'Thing'), { type: 'class', note: 'Thing' })
  assert.deepEqual(briefOf('import os', 'os'), { type: 'module', note: 'os' })
  // An ordinary object — only the name of its type, and not a word more.
  assert.deepEqual(briefOf('class Thing: pass\nthing = Thing()', 'thing'), { type: 'Thing' })
})

test('neither len nor repr is called on an unfamiliar object', { skip: PYTHON ? false : 'no python3' }, () => {
  /*
   * An object whose methods both THROW: if they are called, the answer becomes
   * empty or the test fails. That is what a database cursor looks like, where
   * `len()` is a query, and a lazy collection that `repr()` forces to compute.
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

test('no name — no answer', { skip: PYTHON ? false : 'no python3' }, () => {
  assert.equal(briefOf('x = 1', 'нетТакого'), null)
  assert.equal(briefOf('x = 1', 'x.нетТакого'), null)
  assert.equal(briefOf('x = 1', ''), null)
})

test('an attribute chain is read dot by dot', { skip: PYTHON ? false : 'no python3' }, () => {
  const setup = 'class Box:\n    def __init__(self): self.size = (3, 4)\nbox = Box()'
  assert.deepEqual(briefOf(setup, 'box.size'), { type: 'tuple[int]', dims: '2' })
})

test('pandas and numpy answer with size and data type', { skip: HAS('numpy') ? false : 'no numpy' }, () => {
  const X = briefOf('import numpy as np\nX = np.zeros((100, 3))', 'X')
  assert.deepEqual(X, { type: 'ndarray', dtype: 'float64', dims: '(100, 3)' })
  // A numpy scalar is a VALUE, not "np.float64(3.5)".
  const one = briefOf('import numpy as np\none = np.float64(3.5)', 'one')
  assert.deepEqual(one, { type: 'float64', value: '3.5' })
})

test('DataFrame and Series: rows, columns, data type', { skip: HAS('pandas') ? false : 'no pandas' }, () => {
  const setup = 'import pandas as pd\ndf = pd.DataFrame({"a": [1.0, 2.0], "b": [3.0, 4.0]})'
  assert.deepEqual(briefOf(setup, 'df'), { type: 'DataFrame', dims: '2 × 2' })
  const series = briefOf(setup + '\ns = df["a"]', 's')
  assert.equal(series?.type, 'Series')
  assert.equal(series?.dims, '2')
  assert.equal(series?.dtype, 'float64')
  assert.equal(series?.note, 'a')
  // `df.shape` is an ordinary tuple, and it is answered as a tuple.
  assert.deepEqual(briefOf(setup, 'df.shape'), { type: 'tuple[int]', dims: '2' })
})

test('the kernel reports facts without words, and the server says them in the room language', () => {
  // The kernel does not know the room's language: a network's size and an
  // estimator's state come as a number and a flag, and parseBrief words them.
  const brief = (said: object) => parseBrief(JSON.stringify({ found: true, brief: said }))
  try {
    setLocaleResolver(() => 'ru')
    assert.deepEqual(brief({ type: 'Net', params: 1 }), { type: 'Net', note: '1 параметр' })
    assert.deepEqual(brief({ type: 'Net', params: 22 }), { type: 'Net', note: '22 параметра' })
    assert.deepEqual(brief({ type: 'Net', params: 5 }), { type: 'Net', note: '5 параметров' })
    assert.deepEqual(brief({ type: 'LinearRegression', fitted: false }), { type: 'LinearRegression', note: 'не обучен' })
    setLocaleResolver(() => 'en')
    assert.deepEqual(brief({ type: 'Net', params: 1 }), { type: 'Net', note: '1 parameter' })
    assert.deepEqual(brief({ type: 'Net', params: 1200 }), { type: 'Net', note: '1,200 parameters' })
    assert.deepEqual(brief({ type: 'LinearRegression', fitted: true }), { type: 'LinearRegression', note: 'fitted' })
    assert.deepEqual(brief({ type: 'LinearRegression', fitted: false }), { type: 'LinearRegression', note: 'not fitted' })
    // Junk from the kernel is ignored, not printed.
    assert.deepEqual(brief({ type: 'Net', params: -1 }), { type: 'Net' })
    assert.deepEqual(brief({ type: 'Net', params: '12' }), { type: 'Net' })
  } finally {
    setLocaleResolver(() => 'ru')
  }
})

test('a network and an estimator come out of the kernel as facts, not Russian words', {
  skip: PYTHON ? false : 'no python3',
}, () => {
  // Stand-ins for torch.nn and sklearn.base: the branches run without the real
  // libraries, which are not on every machine that runs these tests.
  const torch = [
    'import sys, types',
    "torch = types.ModuleType('torch'); nn = types.ModuleType('torch.nn')",
    'class Tensor: pass',
    'class Parameter:',
    '    def __init__(self, n): self.n = n',
    '    def numel(self): return self.n',
    'class Module:',
    '    def parameters(self): return [Parameter(3), Parameter(19)]',
    "torch.Tensor = Tensor; nn.Module = Module; torch.nn = nn",
    "sys.modules['torch'] = torch; sys.modules['torch.nn'] = nn",
    'class Net(Module): pass',
    'net = Net()',
  ].join('\n')
  assert.deepEqual(briefOf(torch, 'net'), { type: 'Net', note: '22 параметра' })
  const sklearn = [
    'import sys, types',
    "base = types.ModuleType('sklearn.base')",
    'class BaseEstimator: pass',
    'base.BaseEstimator = BaseEstimator',
    "sys.modules['sklearn'] = types.ModuleType('sklearn'); sys.modules['sklearn.base'] = base",
    'class LinearRegression(BaseEstimator): pass',
    'model = LinearRegression()',
    'trained = LinearRegression(); trained.coef_ = [1.0]',
  ].join('\n')
  assert.deepEqual(briefOf(sklearn, 'model'), { type: 'LinearRegression', note: 'не обучен' })
  assert.deepEqual(briefOf(sklearn, 'trained'), { type: 'LinearRegression', note: 'обучен' })
})

test('an sklearn estimator says whether it is fitted — without calling methods', {
  skip: HAS('sklearn') ? false : 'no sklearn',
}, () => {
  const setup = 'from sklearn.linear_model import LinearRegression\nmodel = LinearRegression()'
  assert.deepEqual(briefOf(setup, 'model'), { type: 'LinearRegression', note: 'не обучен' })
})
