import type { SyntaxNode, Tree } from '@lezer/common'

/**
 * What help can be asked about by hovering the pointer — and what cannot.
 *
 * The hover target used to be found by a regex over the line: ANY word under
 * the pointer. In a class this turned out to be unbearable — "whenever you
 * hover over code or write code, something pops up": the window jumped out
 * over a quoted column name, over `x=` in an argument list, over one's own
 * variable, over a word in a comment. And every such hover cost an `inspect`
 * frame on the socket and a question to the room's shared kernel.
 *
 * Now the target is found by the PARSE TREE (the Python grammar from
 * @lezer/python, the same one the editor colours code with), and the rule is
 * narrow:
 *
 *   1. a name in an import statement — module, submodule, imported name, alias;
 *   2. the name of the CALLEE: an argument list follows it right away
 *      (`print(`, `sns.lmplot(`, `LinearRegression(`, `@lru_cache`);
 *   3. a link of the callee's chain and a dotted access — but only if the root
 *      of the chain is a known alias of an imported module (`np` in
 *      `np.random.rand(`). `df` in `df.groupby(` is not an alias, and it is not
 *      asked about: what `df` is, the kernel will tell by its own name when it
 *      is hovered elsewhere.
 *
 * Everything else is silence, and silence WITHOUT a question to the server:
 * strings and f-strings entirely, comments, numbers, keyword argument names,
 * argument values, variables and attributes without a call, the left side of
 * an assignment, `def` parameters, names in `for … in`, the name of the
 * function or class being defined.
 *
 * A pure module: in go the tree, the text and the position, out comes a
 * target or the reason for refusal. No CodeMirror and no DOM — so that the
 * table of cases can be checked with the real parser in an ordinary test
 * (tests/hover-target.test.mts).
 */

/** Nodes we consider a name. Anything else under the pointer is not a name. */
const NAMES = new Set(['VariableName', 'PropertyName'])

/** Foreign text: there are no names inside it, however many seem to be visible. */
const PROSE = new Set(['String', 'FormatString', 'Comment'])

/** A call's argument list — it decides whether this is help or a value. */
const ARGS = new Set(['ArgList'])

/**
 * Why there will be no help. Needed by the test and by the explanation, not by
 * the screen: to a person a hover refusal shows as nothing happening — which
 * is exactly the intent.
 */
export type HoverRefusal =
  | 'no-name'
  | 'prose'
  | 'keyword-argument'
  | 'definition'
  | 'parameter'

export interface HoverTarget {
  /** The name's bounds in the document — the tooltip highlights them. */
  from: number
  to: number
  /** What we ask the kernel about: a dotted chain ending in this name. */
  ask: string
  /**
   * What to show: full help or a line about the value.
   *
   * `help` — an import, a callee, a module: signature, documentation, package;
   * a scrolling window. `value` — an ordinary name: `apartments`, `df.shape`,
   * `X` in an argument list. About such a thing a person asks something else —
   * "what is it and how big is it" — and answering that with a wagonload of
   * text (the owner's complaint of 21 Sep 2026: "it also added a wagonload of
   * detailed text there, that's not much fun") means not answering at all. One
   * line, no window.
   */
  kind: 'help' | 'value'
}

export interface HoverAnswer {
  target: HoverTarget | null
  why: HoverRefusal | null
}

const REFUSE = (why: HoverRefusal): HoverAnswer => ({ target: null, why })

/** Climb the tree: the nearest ancestor with this name — or `null`. */
function ancestor(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let up: SyntaxNode | null = node.parent; up; up = up.parent) {
    if (up.name === name) return up
  }
  return null
}

function anyAncestor(node: SyntaxNode, names: Set<string>): SyntaxNode | null {
  for (let up: SyntaxNode | null = node.parent; up; up = up.parent) {
    if (names.has(up.name)) return up
  }
  return null
}

/**
 * The largest dotted access ENDING in this name.
 *
 * `scatter` in `px.scatter(...)` climbs up to `px.scatter`, while `px` stays
 * itself: the chain grows only to the right of the name, because we always
 * ask about what is under the pointer, not about what is to its right.
 */
function chainEndingHere(node: SyntaxNode): SyntaxNode {
  let expr = node
  for (
    let up: SyntaxNode | null = expr.parent;
    up && up.name === 'MemberExpression' && up.to === expr.to;
    up = expr.parent
  ) {
    expr = up
  }
  return expr
}

/** The largest dotted access the name is part of in any way. */
function wholeChain(node: SyntaxNode): SyntaxNode {
  let expr = node
  for (let up: SyntaxNode | null = expr.parent; up && up.name === 'MemberExpression'; up = expr.parent) {
    expr = up
  }
  return expr
}

/** The chain's leftmost link: `np` of `np.random.rand`. */
function chainRoot(node: SyntaxNode): SyntaxNode {
  let at = node
  while (at.name === 'MemberExpression') {
    const first = at.firstChild
    if (!first) break
    at = first
  }
  return at
}

/** A call in which this expression is the callee (not an argument). */
function calledHere(expr: SyntaxNode): boolean {
  const up = expr.parent
  return up?.name === 'CallExpression' && up.firstChild?.from === expr.from
}

/**
 * The dotted chain ending here — in words, as it is put to the kernel.
 *
 * By the text, not by the tree, and on purpose: `df.groupby("a").agg` would be
 * assembled whole from the tree, but such a question cannot be put to the
 * kernel anyway — there is a call inside that nobody is going to execute.
 * Character-level parsing stops at the closing bracket exactly where the
 * kernel would stop.
 */
function askFor(doc: string, to: number): { from: number; ask: string } | null {
  const head = doc.slice(0, to)
  const found = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(head)
  if (!found) return null
  return { from: found.index, ask: found[0] }
}

/**
 * What is under the pointer — a target for help, or a refusal.
 *
 * `aliases` — the names bound by imports in this notebook (`moduleAliases`).
 * An empty set breaks nothing: rules 1 and 2 work without it, and rule 3
 * simply does not fire.
 */
export function hoverTarget(input: {
  tree: Tree
  doc: string
  at: number
  aliases?: ReadonlySet<string>
}): HoverAnswer {
  const { tree, doc, at } = input
  const aliases = input.aliases ?? new Set<string>()
  /*
   * First to the right, then to the left: a pointer resting on a name's last
   * letter arrives here as the position AFTER it, and resolving from the
   * "after" side would return a space. A tree with error nodes (and while
   * typing it almost always is one) does not break from this: no name found —
   * we stay silent.
   */
  let node = tree.resolveInner(at, 1)
  if (!NAMES.has(node.name)) node = tree.resolveInner(at, -1)
  /*
   * Foreign text as a whole — and it is checked BEFORE the name.
   *
   * A string and a number arrive here as one node, with no names inside
   * ("area_sqm" is a String, not a VariableName), and a comment all the more
   * so: it may hold all of yesterday's code. The only place where there is a
   * name inside foreign text after all is an f-string substitution, and it is
   * foreign text too: Python substitutes it, and it is asked about where it is
   * written.
   */
  if (PROSE.has(node.name) || anyAncestor(node, PROSE)) return REFUSE('prose')
  if (!NAMES.has(node.name)) return REFUSE('no-name')

  const from = node.from
  const to = node.to
  const named = askFor(doc, to)
  if (!named) return REFUSE('no-name')
  const spot = { from: Math.min(from, named.from), to, ask: named.ask }
  const target: HoverTarget = { ...spot, kind: 'help' }
  /** The same spot, but about the value: one line instead of a window. */
  const brief: HoverAnswer = { target: { ...spot, kind: 'value' }, why: null }

  // 1. An import statement: every name in it can be asked about.
  if (ancestor(node, 'ImportStatement')) return { target, why: null }

  // 2. The callee. Checked BEFORE the argument-list refusal: `g` in
  // `f(g(x))` is a call, not an argument value.
  const ending = chainEndingHere(node)
  if (calledHere(ending)) return { target, why: null }
  /*
   * A decorator without brackets is a call too, only Python itself calls it.
   * `@lru_cache` and `@lru_cache(maxsize=2)`: in the first case the name sits
   * right under `Decorator`, in the second the callee rule above has already
   * caught it.
   */
  if (ancestor(node, 'Decorator') && !ancestor(node, 'ArgList')) return { target, why: null }

  // From here on — only refusals and rule 3.
  const parent = node.parent
  if (parent?.name === 'ArgList') {
    /*
     * A keyword argument's name is a key, not a value: there is nothing to ask
     * about `x=` in `px.scatter(df, x="a")`, it does not even have an object.
     */
    const next = node.nextSibling
    if (next?.name === 'AssignOp') return REFUSE('keyword-argument')
  }
  if (parent?.name === 'ParamList') return REFUSE('parameter')
  if (parent?.name === 'FunctionDefinition' || parent?.name === 'ClassDefinition') {
    // The name of the function or class being defined is a declaration, not a call.
    return REFUSE('definition')
  }
  /*
   * A name to the left of `=` and names in `for … in` are VALUES, not
   * declarations.
   *
   * Until 21 Sep 2026 they were silent: the kernel told a wagonload of text
   * about a variable, and it was better not to ask at all. With a short line it
   * is worth answering about them — `apartments` to the left of `=` is exactly
   * the table whose size the person wants to see by hovering the mouse over it.
   */

  const chain = wholeChain(node)
  const root = chainRoot(chain)
  const rooted = doc.slice(root.from, root.to)
  /*
   * 3. A known alias of an imported module — and only that.
   *
   * `np` in `np.random.rand(` is asked about, `df` in `df.groupby(` is not. The
   * difference is not in the form but in that about the first we know FOR
   * SURE: it is a package, the person imported it themselves a line above.
   * Only the kernel knows about the second, and it is mostly hovered in
   * passing.
   */
  const knows = aliases.has(rooted)
  /*
   * A module alias outside an argument list gets full help: there is
   * something to tell about a package, and the person hovers it for exactly
   * that.
   */
  if (knows && !anyAncestor(node, ARGS)) return { target, why: null }
  /*
   * Everything else that is a name after all is a VALUE.
   *
   * `apartments` in an argument list and also to the left of `=`, `df` on a
   * line of its own, `xs` in `for x in xs`, an attribute chain without a call
   * (`df.shape`, `model.coef_`), and even `np.mean` passed into `df.apply`.
   * One short line is shown about them — type and size — and it costs one
   * quiet question to a kernel that already knows the answer: the object has
   * been computed and sits in memory. The kernel is not started for this, and
   * nothing is guessed statically: no answer — no line.
   */
  return brief
}

/**
 * The same for the CARET — the Shift+Tab gesture, and it is deliberately
 * wider than hovering.
 *
 * The key is pressed deliberately and once, so the main Jupyter case is added
 * to the allowed names: a caret inside a call's brackets
 * (`px.scatter(apartments, x=|`) shows the signature of what is being called.
 * Hovering cannot do this — otherwise the window would pop up over every
 * argument the person is typing at that second.
 */
export function caretTarget(input: {
  tree: Tree
  doc: string
  at: number
  aliases?: ReadonlySet<string>
}): HoverAnswer {
  const direct = hoverTarget(input)
  if (direct.target) return direct
  const { tree, doc, at } = input
  /*
   * The nearest enclosing call. The nearest precisely: in a nested
   * `f(g(x, |))` the hint is about `g` — the one whose arguments are being
   * typed.
   */
  for (let node: SyntaxNode | null = tree.resolveInner(at, -1); node; node = node.parent) {
    if (node.name !== 'ArgList') continue
    const call = node.parent
    if (call?.name !== 'CallExpression') continue
    const callee = call.firstChild
    if (!callee || callee.from === node.from) continue
    const named = askFor(doc, callee.to)
    if (!named) continue
    return {
      target: { from: Math.min(callee.from, named.from), to: callee.to, ask: named.ask, kind: 'help' },
      why: null,
    }
  }
  return direct
}

/* ----------------------------------------------------------- import aliases */

/** A top-level import line — the same form as the server's header uses. */
const IMPORT_LINE = /^import\s+(.+)$/
const FROM_LINE = /^from\s+[.\w]+\s+import\s+(.+)$/

/**
 * The names bound by imports in this notebook.
 *
 * `import numpy as np` gives `np`, `import pandas` — `pandas`,
 * `import matplotlib.pyplot as plt` — `plt`, `from sklearn import
 * linear_model` — `linear_model`. Computed from the text, without parsing:
 * this is a hint about what MAY be asked about, and it can only err towards
 * an extra name in the list.
 *
 * Names from `from … import …` get here on a par with modules, although there
 * are classes among them too (`from pandas import DataFrame`). One cannot be
 * told from the other by the text, and the cost of a mistake is negligible: a
 * person hovered a name they imported themselves and got help about it —
 * exactly what they wanted.
 */
export function moduleAliases(sources: readonly string[]): Set<string> {
  const found = new Set<string>()
  for (const source of sources) {
    if (typeof source !== 'string' || !source.includes('import')) continue
    // A cell in another language (`%%bash`) is not Python, and it has no names.
    if (/^\s*%%/.test(source)) continue
    for (const row of source.split('\n')) {
      const line = row.trim()
      if (line !== row.replace(/\s+$/, '')) continue // an indented import — inside a try/function
      const plain = IMPORT_LINE.exec(line)?.[1]
      const from = FROM_LINE.exec(line)?.[1]
      const list = plain ?? from
      if (list === undefined) continue
      for (const piece of list.split(',')) {
        const part = piece.trim().replace(/[()]/g, '').trim()
        if (part === '' || part === '*') continue
        const words = part.split(/\s+as\s+/)
        const bound = (words[1] ?? words[0]).trim()
        if (bound === '') continue
        // `import a.b.c` binds `a`; `import a.b as x` binds `x`.
        const name = words.length > 1 ? bound : bound.split('.')[0]
        if (/^[A-Za-z_]\w*$/.test(name)) found.add(name)
      }
    }
  }
  return found
}
