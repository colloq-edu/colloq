/**
 * Where one may hover for help — and where not.
 *
 * The complaint from the class of 21 Sep 2026, verbatim: "so that the docs
 * appear only when hovering over packages, over their import and over the
 * names of the functions themselves — and do not get highlighted when
 * hovering over just a string or over the arguments of a function call,
 * because otherwise any hover over code or any typing of code will make
 * something pop up, and that is not cool".
 *
 * Before this, the target was found with a regex over the line: ANY word
 * under the pointer, including a column name in quotes, `x=` in an argument
 * list and a word in a comment. And every such hover cost an `inspect` frame
 * on the socket and a question to the room's shared kernel — that is, the
 * cost of a mistake was not only the window that popped up at the wrong time.
 *
 * Here a table of cases is checked with the real Python parser (the same
 * @lezer/python the editor uses to colour code) — on trees built from text,
 * not on made-up nodes: the rule lives by the grammar's node names, and a
 * faked tree would check our ideas about the grammar rather than the grammar
 * itself.
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

/** The aliases of a course notebook: the third rule lives by them. */
const ALIASES = moduleAliases([
  'import numpy as np',
  'import pandas as pd\nimport plotly.express as px',
  'from sklearn.linear_model import LinearRegression as LR',
  'import seaborn as sns\nimport os',
])

/**
 * Hover over a word — and say what came of it.
 *
 * The position is taken inside the word (the first letter plus one
 * character): that is how a real hover arrives, and the caret behaves the
 * same way.
 */
function hover(code: string, word: string, nth = 0): string {
  const tree = parser.parse(code)
  let at = -1
  for (let i = 0; i <= nth; i++) at = code.indexOf(word, at + 1)
  assert.ok(at !== -1, `the code has no "${word}"`)
  const answer = hoverTarget({ tree, doc: code, at: at + 1, aliases: ALIASES })
  return answer.target ? `${answer.target.kind}:${answer.target.ask}` : `no:${answer.why as HoverRefusal}`
}

function caret(code: string, at: number): string {
  const answer = caretTarget({ tree: parser.parse(code), doc: code, at, aliases: ALIASES })
  return answer.target ? `${answer.target.kind}:${answer.target.ask}` : `no:${answer.why as HoverRefusal}`
}

/* ------------------------------------------------------------- what is allowed */

test('a name in an import statement is asked about whole — both the module and the alias', () => {
  const plain = 'import numpy as np'
  assert.equal(hover(plain, 'numpy'), 'help:numpy')
  assert.equal(hover(plain, 'np'), 'help:np')

  const dotted = 'import matplotlib.pyplot as plt'
  assert.equal(hover(dotted, 'matplotlib'), 'help:matplotlib')
  // A submodule is asked about together with its package: `pyplot` on its own
  // means nothing.
  assert.equal(hover(dotted, 'pyplot'), 'help:matplotlib.pyplot')

  const from = 'from sklearn.linear_model import LinearRegression as LR'
  assert.equal(hover(from, 'sklearn'), 'help:sklearn')
  assert.equal(hover(from, 'linear_model'), 'help:sklearn.linear_model')
  assert.equal(hover(from, 'LinearRegression'), 'help:LinearRegression')
  assert.equal(hover(from, 'LR'), 'help:LR')
})

test('the name of the callee — plain, dotted and a constructor', () => {
  assert.equal(hover('print("hi")', 'print'), 'help:print')
  assert.equal(hover('sns.lmplot(data=df)', 'lmplot'), 'help:sns.lmplot')
  assert.equal(hover('LR()', 'LR'), 'help:LR')
  // A nested call is a call too: `g` in `f(g(x))` is asked about, even though
  // it stands inside an argument list.
  assert.equal(hover('f(g(x))', 'g'), 'help:g')
})

test('a decorator is a call that Python itself makes', () => {
  assert.equal(hover('@lru_cache\ndef f(x):\n    return x', 'lru_cache'), 'help:lru_cache')
  assert.equal(hover('@lru_cache(maxsize=2)\ndef f(x):\n    return x', 'lru_cache'), 'help:lru_cache')
  // And its arguments are still just arguments.
  assert.equal(hover('@lru_cache(maxsize=2)\ndef f(x):\n    return x', 'maxsize'), 'no:keyword-argument')
})

test('an early link of a chain — only for a known alias', () => {
  assert.equal(hover('px.scatter(df)', 'px'), 'help:px')
  assert.equal(hover('np.random.rand(3)', 'np'), 'help:np')
  // A middle link is asked about together with the root: `np.random` is a
  // module.
  assert.equal(hover('np.random.rand(3)', 'random'), 'help:np.random')
  /*
   * But `df` is not an alias: there will be no full help about it. Since
   * 21 Sep 2026, though, there is a SHORT line about it — type and size —
   * because that is exactly what a person asks about their own table.
   */
  assert.equal(hover('df.groupby("a").agg(sum)', 'df'), 'value:df')
  // The called method itself, however, is asked about — as before, by the
  // last link.
  assert.equal(hover('df.groupby("a").agg(sum)', 'agg'), 'help:agg')
  assert.equal(hover('df.groupby("a")', 'groupby'), 'help:df.groupby')
})

test('a package attribute gets help, an attribute of another object gets a short line', () => {
  assert.equal(hover('x = np.pi', 'pi'), 'help:np.pi')
  // An attribute chain without a call: `df.shape` is a value, and it gets a
  // one-line answer — "tuple · 2", not a page about tuples.
  assert.equal(hover('rows = df.shape', 'shape'), 'value:df.shape')
  assert.equal(hover('rows = df.shape', 'df'), 'value:df')
  assert.equal(hover('score = model.coef_', 'coef_'), 'value:model.coef_')
})

/* ------------------------------------------------------------ what is not */

test('strings, f-strings and comments stay silent entirely', () => {
  assert.equal(hover('px.scatter(df, x="area_sqm")', 'area_sqm'), 'no:prose')
  // A name inside an f-string is just letters: Python substitutes it, not the
  // person.
  assert.equal(hover('s = f"{name} и дальше"', 'name'), 'no:prose')
  assert.equal(hover('# print(df) — потом\nx = 1', 'print'), 'no:prose')
  assert.equal(hover('x = 1  # про numpy\n', 'numpy'), 'no:prose')
})

test('in an argument list: a name gets a short line, a keyword and a literal get nothing', () => {
  const line = 'px.scatter(apartments, x="area_sqm", hover_data=["offer_id", "metro"])'
  /*
   * An argument's value is a variable, and people ask about it "what is it
   * and how big". There is still no documentation window here: `value` is one
   * line.
   */
  assert.equal(hover(line, 'apartments'), 'value:apartments')
  // And the key of a keyword argument is not an object at all.
  assert.equal(hover(line, 'x='), 'no:keyword-argument')
  assert.equal(hover(line, 'hover_data'), 'no:keyword-argument')
  assert.equal(hover(line, 'offer_id'), 'no:prose')
  // A passed function is a value too: one line will say what function it is.
  assert.equal(hover('df.apply(np.mean)', 'np'), 'value:np')
  assert.equal(hover('df.apply(np.mean)', 'mean'), 'value:np.mean')
})

test('declarations stay silent, and an assigned name is a value', () => {
  // A name that is only being declared is not an object: there is no help
  // about it in any form.
  assert.equal(hover('def helper(size):\n    return size', 'helper'), 'no:definition')
  assert.equal(hover('def helper(size):\n    return size', 'size'), 'no:parameter')
  assert.equal(hover('class Model(Base):\n    pass', 'Model'), 'no:definition')
  /*
   * But on the left of `=` and in `for … in` there are ordinary variables:
   * `apartments` on the left of an assignment is exactly the table whose size
   * people want to see.
   */
  assert.equal(hover('total = 1', 'total'), 'value:total')
  assert.equal(hover('for row in rows:\n    pass', 'row'), 'value:row')
  assert.equal(hover('for row in rows:\n    pass', 'rows'), 'value:rows')
})

test('neither numbers, nor keywords, nor empty space', () => {
  assert.equal(hover('x = 42', '42'), 'no:no-name')
  assert.equal(hover('for row in rows:\n    pass', 'for'), 'no:no-name')
  assert.equal(hover('x = 1', ' ', 1), 'no:no-name')
})

test('unfinished code does not crash the parse, it just stays silent', () => {
  /*
   * While typing, the tree almost always carries traces of errors, and that
   * is NORMAL: a person types `px.scatter(` and hovers the mouse in that very
   * second. The rule must answer, not throw.
   */
  for (const broken of ['px.scatter(', 'df.', 'import ', 'def f(', 'x = (', '@']) {
    const tree = parser.parse(broken)
    for (let at = 0; at <= broken.length; at++) {
      assert.doesNotThrow(() => hoverTarget({ tree, doc: broken, at, aliases: ALIASES }))
    }
  }
  // And the callee name is read even in an unfinished line — the bracket is
  // already there.
  assert.equal(hover('px.scatter(', 'scatter'), 'help:px.scatter')
})

/* ------------------------------------------------------------- Shift+Tab */

test('a caret inside the brackets shows the signature of what is being called', () => {
  const line = 'px.scatter(apartments, x='
  // Exactly the Jupyter case: I type arguments and ask which ones there are.
  assert.equal(caret(line, line.length), 'help:px.scatter')
  /*
   * And on the argument itself — its short line: the gesture is the same, but
   * the caret is on a variable, and the question is about it, not the call.
   */
  assert.equal(caret(line, line.indexOf('apartments') + 3), 'value:apartments')
  // A nested call: the hint is about the one whose arguments are being typed.
  const nested = 'f(g(x, ))'
  assert.equal(caret(nested, nested.indexOf('x, ') + 3), 'help:g')
})

test('the caret is allowed everything hovering is allowed', () => {
  const line = 'px.scatter(df)'
  assert.equal(caret(line, line.indexOf('scatter') + 1), 'help:px.scatter')
  assert.equal(caret('import numpy as np', 8), 'help:numpy')
})

test('without an enclosing call the caret finds nothing', () => {
  // An indent without a call — there Shift+Tab must stay a dedent.
  assert.equal(caret('def f():\n    return 1', 14), 'no:no-name')
  assert.equal(caret('    x = 1', 2), 'no:no-name')
})

/* ------------------------------------------------------------ aliases */

test('aliases are collected from the notebook text', () => {
  assert.deepEqual([...moduleAliases(['import numpy as np'])], ['np'])
  // `import a.b.c` binds `a`, not `c`.
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
  // An indented import is inside a try or a function: it is not in the
  // notebook's header.
  assert.deepEqual([...moduleAliases(['try:\n    import cv2\nexcept ImportError:\n    cv2 = None'])], [])
  // A cell in another language is not Python.
  assert.deepEqual([...moduleAliases(['%%bash\nimport nothing'])], [])
  // Cells without the word import are not parsed at all.
  assert.deepEqual([...moduleAliases(['x = 1', 'print(x)'])], [])
  assert.deepEqual([...moduleAliases(['from x import *'])], [])
})
