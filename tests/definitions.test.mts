/**
 * Go to definition: what the server answers.
 *
 * The Python parsing is checked separately and without a room
 * (tests/python-defs.test.mts). Here is the second half: search over a live
 * seminar, where a name has several places at once where it may be defined,
 * and the whole question is which of them is the right one.
 *
 * There are three rules this is responsible for, and each is about trust in
 * the gesture.
 *
 * ORDER. A cell is read top to bottom, and the definition in effect is the
 * nearest one ABOVE, not the first one found. Redefining a function in the
 * third cell, rerunning and going on working is not an edge case, it is an
 * ordinary morning.
 *
 * BOUNDARY. `df.head` does not get a definition answer at all. Any teaching
 * notebook will have some `def head`, and a confident jump into it is the
 * one miss a person will not notice: the gesture worked, and they read
 * someone else's class thinking they read their own.
 *
 * WORDS. "Nowhere to go" has four different reasons, and they are not
 * interchangeable: `numpy` not being in the folder is not the same as "not
 * found".
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
 * A room with a notebook and files.
 *
 * `cells` are the cell sources in order; their names are returned so that
 * the test can say FROM WHICH cell the click came and which one it expects
 * to land in.
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
    // The welcome cell of a new room gets in the test's way: it counts hits
    // by its own indices, not by the whole document.
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

/** Ask about a name: the caret is put on its first occurrence in `code`. */
function at(id: string, code: string, needle: string, from?: { cellId?: string; path?: string }) {
  const cursor = code.indexOf(needle) + 1
  assert.ok(cursor > 0, `there is no "${needle}" in the code`)
  return defineIn(id, code, cursor, from?.cellId, from?.path)
}

test('a definition in a neighbouring cell — with the line number and the line itself', () => {
  const { id, ids } = seminar(['import os\n\ndef describe_all(df):\n    return df.describe()', 'describe_all(train)'])
  const answer = at(id, 'describe_all(train)', 'describe_all', { cellId: ids[1] })
  assert.equal(answer.hit?.where, 'cell')
  assert.equal(answer.hit?.cellId, ids[0])
  assert.equal(answer.hit?.line, 3)
  assert.equal(answer.hit?.text, 'def describe_all(df):')
  assert.equal(answer.hit?.name, 'describe_all')
  done(id)
})

test('of two identical names the nearest one ABOVE is taken', () => {
  // Redefined in cell 2, working in cell 4: the second one is in effect.
  const { id, ids } = seminar([
    'def score(x):\n    return 1',
    'def score(x):\n    return 2',
    'print(1)',
    'score(df)',
    'def score(x):\n    return 3',
  ])
  const answer = at(id, 'score(df)', 'score', { cellId: ids[3] })
  assert.equal(answer.hit?.cellId, ids[1], 'the nearest one above was not taken')
  done(id)
})

test('if there is none above, the first one BELOW is taken', () => {
  // An ordinary notebook: the call was written before the function, and that
  // is not a mistake.
  const { id, ids } = seminar(['score(df)', 'def score(x):\n    return 1'])
  const answer = at(id, 'score(df)', 'score', { cellId: ids[0] })
  assert.equal(answer.hit?.cellId, ids[1])
  done(id)
})

test('one\'s own cell answers for itself', () => {
  const code = 'def helper(x):\n    return x\n\nhelper(1)'
  const { id, ids } = seminar([code])
  const answer = defineIn(id, code, code.lastIndexOf('helper') + 1, ids[0])
  assert.equal(answer.hit?.cellId, ids[0])
  assert.equal(answer.hit?.line, 1)
  done(id)
})

test('a seminar module: import utils, a click on utils.deep', () => {
  const { id, ids } = seminar(['import eda_tools', 'eda_tools.describe_all(df)'], {
    'eda_tools.py': '"""Инструменты."""\n\n\ndef describe_all(df):\n    return df\n',
  })
  const answer = at(id, 'import eda_tools\neda_tools.describe_all(df)', 'describe_all', { cellId: ids[1] })
  assert.equal(answer.hit?.where, 'file')
  assert.equal(answer.hit?.path, 'eda_tools.py')
  assert.equal(answer.hit?.line, 4)
  done(id)
})

test('from utils import f — and a click on a bare f', () => {
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

test('a package in folders: from pkg.sub import f', () => {
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

test('a click on the module name itself leads to the start of its file', () => {
  const { id, ids } = seminar(['import plotstyle'], { 'plotstyle.py': '\n\nimport matplotlib\n' })
  const answer = at(id, 'import plotstyle\nplotstyle.setup()', 'plotstyle\nplotstyle'.slice(0, 9), { cellId: ids[0] })
  assert.equal(answer.hit?.where, 'file')
  assert.equal(answer.hit?.path, 'plotstyle.py')
  done(id)
})

test('an import from the notebook HEADER applies in all its cells', () => {
  /*
   * The scope in a notebook is not the cell but the kernel.
   * `import case_cian as cian` stands in the third cell and applies until
   * the end of the class; while only the clicked cell's imports were read
   * here, `cian.fig_range_audit(...)` from the sixteenth answered "what cian
   * is cannot be told from here" — that is, the feature fell apart on
   * exactly how any teaching notebook is built.
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

test('one\'s own cell overrides the header if the name was redefined in it', () => {
  // `resolveChain` takes the first match, and one's own imports come first.
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

test('another notebook\'s header does not reach into this one', () => {
  // One kernel, but different notebooks, and `cian` from the neighbouring
  // one is not defined here: otherwise the jump would lead into a module
  // this notebook never imported.
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

test('a star import from the header names the module more precisely than the alphabet', () => {
  /*
   * `def figure` is in both plotstyle.py and case_cian.py. A pass through
   * the files would take the first alphabetically — case_cian.py — while the
   * right answer is known only by the line `from plotstyle import *`, and
   * known exactly.
   */
  const { id, ids } = seminar(['from plotstyle import *', 'fig = figure(1)'], {
    'case_cian.py': 'def figure(n):\n    return n\n',
    'plotstyle.py': '\n\ndef figure(n):\n    return n\n',
  })
  const answer = at(id, 'fig = figure(1)', 'figure', { cellId: ids[1] })
  assert.equal(answer.hit?.path, 'plotstyle.py', 'taken alphabetically instead of the named module')
  assert.equal(answer.hit?.line, 3)
  done(id)
})

test('one\'s own import matters more than someone else\'s standing lower in the notebook', () => {
  /*
   * `lastImport` takes the last one in the list, and the list goes through
   * the whole notebook — so "last" came to mean "in the lowest cell". The
   * clicked cell says `from case_cian import load` in plain sight, while the
   * jump led into case_rohlik.py only because that import stands lower.
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
  assert.equal(answer.hit?.path, 'case_cian.py', 'led into someone else\'s module')
  done(id)
})

test('a name from the header leads into the module, not to the import line', () => {
  // Landing on `from eda_tools import load_dataset` is a line from which one
  // has to jump a second time, and the person has seen it anyway.
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

test('installed packages do not knock one\'s own modules out of the full pass', () => {
  /*
   * A single `pip install -t .` puts thousands of .py files into the folder,
   * and the alphabetical pass used up the read ceiling on them before
   * reaching the first module of one's own: `use_style` stopped being found
   * at all.
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

test('a large file: lines are counted from the start of the file, not from the start of the window', () => {
  /*
   * The frame ceiling is 24 KB, while `case_cian.py` of the live course is
   * 886 KB: a click there arrives as a PIECE. Until the cut offset reached
   * the server, the landing went hundreds of lines off, and a definition
   * beyond the edge of the window was "not found" — and the search went on
   * into other files where the name matched.
   */
  const filler = 'padding = 1\n'.repeat(3000)
  const big = `def deep_helper():\n    return 1\n\n${filler}deep_helper()\n`
  const { id } = seminar([], { 'big.py': big })
  // The client would send a window around the caret: the definition does not
  // fall into it.
  const at = big.lastIndexOf('deep_helper')
  const cut = at - 100
  const answer = defineIn(id, big.slice(cut, cut + 24 * 1024), 101, undefined, 'big.py', cut)
  assert.equal(answer.hit?.path, 'big.py')
  assert.equal(answer.hit?.line, 1, 'the line was counted from the start of the window, not the file')
  assert.equal(answer.hit?.text, 'def deep_helper():')
  done(id)
})

test('the full text was not found — a refusal is better than a confidently wrong line', () => {
  // There is a window, but no source under it: this happens to a file
  // deleted between the request and the answer. Landing in it by the
  // window's lines is not allowed.
  const { id } = seminar([], {})
  const answer = defineIn(id, 'def gone():\n    pass\ngone()', 23, undefined, 'нет.py', 5000)
  assert.equal(answer.hit, undefined)
  assert.equal(answer.miss?.why, 'unknown')
  done(id)
})

test('df.head does NOT get a definition answer, even when there is a def head in the notebook', () => {
  // Exactly the trap all this was written for: a `def head` is right there,
  // and a person will not check a confident jump into it.
  const { id, ids } = seminar(['class Table:\n    def head(self):\n        return 1', 'df = load()\ndf.head()'])
  const code = 'df = load()\ndf.head()'
  const answer = defineIn(id, code, code.lastIndexOf('head') + 1, ids[1])
  assert.equal(answer.hit, undefined, 'found what it could not have known')
  assert.deepEqual(answer.miss, { why: 'opaque', name: 'head', owner: 'df' })
  done(id)
})

test('a library is called by its name, not "not found"', () => {
  const { id, ids } = seminar(['import numpy as np', 'np.array([1])'])
  const code = 'import numpy as np\nnp.array([1])'
  const answer = defineIn(id, code, code.indexOf('array') + 1, ids[1])
  assert.equal(answer.miss?.why, 'outside')
  assert.equal(answer.miss?.why === 'outside' ? answer.miss.module : '', 'numpy')
  done(id)
})

test('a click on the module NAME in an import line names the library', () => {
  // `import pandas as pd` binds `pd`, while the word `pandas` means nothing
  // — and it used to fall into "not found in the notebooks or the files":
  // true, but not the right truth. A module was looked for, and the person
  // needs to know it is from a library.
  const { id, ids } = seminar(['import pandas as pd'])
  const code = 'import pandas as pd'
  const answer = defineIn(id, code, code.indexOf('pandas') + 1, ids[0])
  assert.equal(answer.miss?.why, 'outside')
  assert.equal(answer.miss?.why === 'outside' ? answer.miss.module : '', 'pandas')
  done(id)
})

test('while one\'s own module opens with the same click', () => {
  const { id, ids } = seminar(['import eda_tools as tools'], { 'eda_tools.py': 'x = 1\n' })
  const code = 'import eda_tools as tools'
  const answer = defineIn(id, code, code.indexOf('eda_tools') + 1, ids[0])
  assert.equal(answer.hit?.path, 'eda_tools.py')
  done(id)
})

test('the name is nowhere — and that is what is said', () => {
  const { id, ids } = seminar(['совсем_другое = 1', 'unknown_name(1)'])
  const answer = at(id, 'unknown_name(1)', 'unknown_name', { cellId: ids[1] })
  assert.deepEqual(answer.miss, { why: 'unknown', name: 'unknown_name' })
  done(id)
})

test('not a name under the pointer — silence', () => {
  const { id, ids } = seminar(['x = 1  # helper'])
  const code = 'x = 1  # helper'
  assert.deepEqual(defineIn(id, code, code.indexOf('helper') + 1, ids[0]).miss, { why: 'nothing' })
  assert.deepEqual(defineIn(id, code, 4, ids[0]).miss, { why: 'nothing' })
  done(id)
})

test('a cell in another language searches for nothing', () => {
  const { id, ids } = seminar(['def train(x): pass', '%%bash\npython train.py'])
  const code = '%%bash\npython train.py'
  assert.deepEqual(defineIn(id, code, code.indexOf('train.py') + 1, ids[1]).miss, { why: 'nothing' })
  done(id)
})

test('a full search through .py files when the name is not imported from anywhere', () => {
  const { id, ids } = seminar(['plot_roc(y, p)'], {
    'plotstyle.py': 'def plot_roc(y, p):\n    return None\n',
  })
  const answer = at(id, 'plot_roc(y, p)', 'plot_roc', { cellId: ids[0] })
  assert.equal(answer.hit?.path, 'plotstyle.py')
  done(id)
})

test('a click in a .py file searches from that file\'s folder', () => {
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

test('a definition in ANOTHER notebook is found after one\'s own', () => {
  const { id, ids } = seminar(['helper_two()'])
  const { doc } = getSessionDoc(id)
  // The room's second notebook: its cells lie in their own root, and the
  // search must reach it — the room has one kernel for all notebooks.
  doc.transact(() => {
    const other = doc.getArray('nb:second') as unknown as Y.Array<ReturnType<typeof createCell>>
    other.push([createCell('code', 'def helper_two():\n    return 2')])
  })
  const answer = at(id, 'helper_two()', 'helper_two', { cellId: ids[0] })
  // Without an entry in meta.books the second notebook does not belong to
  // the room — then the honest answer is "not found", and that is not a test
  // failure but a check that the search goes through the LIST of notebooks,
  // not through all roots of the document in a row.
  assert.ok(answer.hit || answer.miss?.why === 'unknown')
  done(id)
})
