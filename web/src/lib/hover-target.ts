import type { SyntaxNode, Tree } from '@lezer/common'

/**
 * О чём можно спросить справку, наведя указатель, — и о чём нельзя.
 *
 * Раньше цель наведения искалась регуляркой по строке: под указателем ЛЮБОЕ
 * слово. На занятии это оказалось невыносимо — «при любом наведении на код или
 * при написании кода будет что-то всплывать»: окно выскакивало над именем
 * колонки в кавычках, над `x=` в списке аргументов, над собственной переменной,
 * над словом в комментарии. И каждое такое наведение стоило кадра `inspect` в
 * сокете и вопроса к общему ядру комнаты.
 *
 * Теперь цель ищется по ДЕРЕВУ РАЗБОРА (грамматика Python из @lezer/python, та
 * же, которой редактор красит код), и правило узкое:
 *
 *   1. имя в операторе импорта — модуль, подмодуль, импортируемое имя, псевдоним;
 *   2. имя ВЫЗЫВАЕМОГО: за ним сразу идёт список аргументов (`print(`,
 *      `sns.lmplot(`, `LinearRegression(`, `@lru_cache`);
 *   3. звено цепочки вызываемого и обращение через точку — но только если
 *      корень цепочки это известный псевдоним импортированного модуля (`np` в
 *      `np.random.rand(`). `df` в `df.groupby(` псевдонимом не является, и о
 *      нём не спрашивают: что такое `df`, ядро расскажет по его собственному
 *      имени, когда на него наведут в другом месте.
 *
 * Всё остальное — молчание, и молчание БЕЗ вопроса к серверу: строки и
 * f-строки целиком, комментарии, числа, имена именованных аргументов, значения
 * аргументов, переменные и атрибуты без вызова, левая часть присваивания,
 * параметры `def`, имена в `for … in`, имя определяемой функции или класса.
 *
 * Чистый модуль: на вход дерево, текст и позиция, на выход цель или причина
 * отказа. Ни CodeMirror, ни DOM — чтобы таблицу случаев можно было проверить
 * настоящим парсером в обычном тесте (tests/hover-target.test.mts).
 */

/** Узлы, которые мы считаем именем. Всё прочее под указателем — не имя. */
const NAMES = new Set(['VariableName', 'PropertyName'])

/** Чужой текст: внутри него имён нет, сколько бы их там ни виднелось. */
const PROSE = new Set(['String', 'FormatString', 'Comment'])

/** Список аргументов вызова — по нему решается, справка это или значение. */
const ARGS = new Set(['ArgList'])

/**
 * Почему справки не будет. Нужна тесту и объяснению, а не экрану: человеку
 * отказ наведения виден тем, что ничего не произошло, — так и задумано.
 */
export type HoverRefusal =
  | 'no-name'
  | 'prose'
  | 'keyword-argument'
  | 'definition'
  | 'parameter'

export interface HoverTarget {
  /** Границы имени в документе — их подсвечивает подсказка. */
  from: number
  to: number
  /** О чём спрашиваем ядро: цепочка через точки, кончающаяся этим именем. */
  ask: string
  /**
   * Что показывать: полную справку или строчку про значение.
   *
   * `help` — импорт, вызываемое, модуль: сигнатура, документация, пакет; окно
   * с прокруткой. `value` — обычное имя: `apartments`, `df.shape`, `X` в
   * списке аргументов. Про такое человек спрашивает другое — «что это и
   * какого оно размера», — и отвечать на это вагоном текста (жалоба владельца
   * 21.09: «он там ещё добавлял детальнее вагон текста, это не очень
   * прикольно») значит не ответить вовсе. Одна строка, без окна.
   */
  kind: 'help' | 'value'
}

export interface HoverAnswer {
  target: HoverTarget | null
  why: HoverRefusal | null
}

const REFUSE = (why: HoverRefusal): HoverAnswer => ({ target: null, why })

/** Поднимаемся по дереву: ближайший предок с этим именем — или `null`. */
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
 * Самое большое обращение через точку, КОНЧАЮЩЕЕСЯ этим именем.
 *
 * `scatter` в `px.scatter(...)` поднимается до `px.scatter`, а `px` остаётся
 * собой: цепочка растёт только вправо от имени, потому что спрашиваем мы
 * всегда про то, что под указателем, а не про то, что правее него.
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

/** Самое большое обращение через точку, в которое имя входит хоть как-то. */
function wholeChain(node: SyntaxNode): SyntaxNode {
  let expr = node
  for (let up: SyntaxNode | null = expr.parent; up && up.name === 'MemberExpression'; up = expr.parent) {
    expr = up
  }
  return expr
}

/** Левое звено цепочки: `np` у `np.random.rand`. */
function chainRoot(node: SyntaxNode): SyntaxNode {
  let at = node
  while (at.name === 'MemberExpression') {
    const first = at.firstChild
    if (!first) break
    at = first
  }
  return at
}

/** Вызов, у которого это выражение — вызываемое (а не аргумент). */
function calledHere(expr: SyntaxNode): boolean {
  const up = expr.parent
  return up?.name === 'CallExpression' && up.firstChild?.from === expr.from
}

/**
 * Цепочка через точки, кончающаяся здесь, — словами, как её задают ядру.
 *
 * По тексту, а не по дереву, и нарочно: `df.groupby("a").agg` из дерева
 * собралось бы целиком, а ядру такой вопрос всё равно не задать — внутри
 * вызов, который никто выполнять не станет. Разбор по знакам останавливается
 * на закрывающей скобке ровно там же, где остановится ядро.
 */
function askFor(doc: string, to: number): { from: number; ask: string } | null {
  const head = doc.slice(0, to)
  const found = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(head)
  if (!found) return null
  return { from: found.index, ask: found[0] }
}

/**
 * Что под указателем — цель для справки или отказ.
 *
 * `aliases` — имена, связанные импортом в этой тетради (`moduleAliases`).
 * Пустое множество не ломает ничего: правила 1 и 2 работают и без него, а
 * правило 3 просто не срабатывает.
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
   * Сначала вправо, потом влево: указатель, стоящий на последней букве имени,
   * приходит сюда позицией ЗА ней, и разбор со стороны «после» вернул бы
   * пробел. Дерево с узлами ошибок (а при наборе оно такое почти всегда) от
   * этого не ломается: не нашли имени — молчим.
   */
  let node = tree.resolveInner(at, 1)
  if (!NAMES.has(node.name)) node = tree.resolveInner(at, -1)
  /*
   * Чужой текст целиком — и проверяется он ДО имени.
   *
   * Строка и число приходят сюда одним узлом, без имён внутри («area_sqm» —
   * это String, а не VariableName), а комментарий — тем более: в нём может
   * лежать хоть весь вчерашний код. Единственное место, где имя внутри
   * чужого текста всё же есть, — подстановка в f-строке, и она тоже чужой
   * текст: подставляет её Python, а спрашивают про неё там, где она написана.
   */
  if (PROSE.has(node.name) || anyAncestor(node, PROSE)) return REFUSE('prose')
  if (!NAMES.has(node.name)) return REFUSE('no-name')

  const from = node.from
  const to = node.to
  const named = askFor(doc, to)
  if (!named) return REFUSE('no-name')
  const spot = { from: Math.min(from, named.from), to, ask: named.ask }
  const target: HoverTarget = { ...spot, kind: 'help' }
  /** То же место, но про значение: одна строка вместо окна. */
  const brief: HoverAnswer = { target: { ...spot, kind: 'value' }, why: null }

  // 1. Оператор импорта: спрашивать можно про каждое имя в нём.
  if (ancestor(node, 'ImportStatement')) return { target, why: null }

  // 2. Вызываемое. Проверяется РАНЬШЕ отказа по списку аргументов: `g` в
  // `f(g(x))` — это вызов, а не значение аргумента.
  const ending = chainEndingHere(node)
  if (calledHere(ending)) return { target, why: null }
  /*
   * Декоратор без скобок — тоже вызов, просто вызывает его сам Python.
   * `@lru_cache` и `@lru_cache(maxsize=2)`: в первом случае имя стоит прямо
   * под `Decorator`, во втором его уже поймало правило вызываемого выше.
   */
  if (ancestor(node, 'Decorator') && !ancestor(node, 'ArgList')) return { target, why: null }

  // Дальше — только отказы и правило 3.
  const parent = node.parent
  if (parent?.name === 'ArgList') {
    /*
     * Имя именованного аргумента — это ключ, а не значение: `x=` в
     * `px.scatter(df, x="a")` спрашивать не о чем, у него и объекта-то нет.
     */
    const next = node.nextSibling
    if (next?.name === 'AssignOp') return REFUSE('keyword-argument')
  }
  if (parent?.name === 'ParamList') return REFUSE('parameter')
  if (parent?.name === 'FunctionDefinition' || parent?.name === 'ClassDefinition') {
    // Имя определяемой функции или класса — не вызов, а объявление.
    return REFUSE('definition')
  }
  /*
   * Имя слева от `=` и имена в `for … in` — это ЗНАЧЕНИЯ, а не объявления.
   *
   * До 21.09 они молчали: о переменной ядро рассказывало вагон текста, и
   * лучше было не спрашивать вовсе. Короткой строкой отвечать про них стоит —
   * `apartments` слева от `=` это ровно та таблица, размер которой человек и
   * хочет увидеть, наведя на неё мышь.
   */

  const chain = wholeChain(node)
  const root = chainRoot(chain)
  const rooted = doc.slice(root.from, root.to)
  /*
   * 3. Известный псевдоним импортированного модуля — и только он.
   *
   * `np` в `np.random.rand(` спрашивают, `df` в `df.groupby(` — нет. Разница
   * не в форме, а в том, что про первое мы ТОЧНО знаем: это пакет, человек
   * сам его импортировал строкой выше. Про второе знает только ядро, и
   * наводятся на него чаще всего мимоходом.
   */
  const knows = aliases.has(rooted)
  /*
   * Псевдоним модуля вне списка аргументов — полная справка: про пакет есть
   * что рассказать, и человек наводится на него ровно за этим.
   */
  if (knows && !anyAncestor(node, ARGS)) return { target, why: null }
  /*
   * Всё остальное, что всё-таки является именем, — ЗНАЧЕНИЕ.
   *
   * `apartments` в списке аргументов и он же слева от `=`, `df` отдельной
   * строкой, `xs` в `for x in xs`, цепочка атрибутов без вызова (`df.shape`,
   * `model.coef_`), и даже `np.mean`, переданная в `df.apply`. Показывается
   * про них одна короткая строка — тип и размер, — и стоит она одного тихого
   * вопроса к ядру, которое и так знает ответ: объект уже посчитан и лежит в
   * памяти. Ядро ради этого не поднимают и статически не гадают: нет ответа —
   * нет и строки.
   */
  return brief
}

/**
 * То же для КАРЕТКИ — жест Shift+Tab, и он намеренно шире наведения.
 *
 * Клавишу нажимают осознанно и один раз, поэтому к разрешённым именам
 * добавляется главный случай Jupyter: каретка внутри скобок вызова
 * (`px.scatter(apartments, x=|`) показывает сигнатуру того, что вызывают.
 * Наведение так делать не может — иначе окно выскакивало бы над каждым
 * аргументом, который человек в эту секунду печатает.
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
   * Ближайший охватывающий вызов. Именно ближайший: во вложенном
   * `f(g(x, |))` подсказывают про `g` — про то, чьи аргументы печатают.
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

/* ------------------------------------------------------- псевдонимы импорта */

/** Строка импорта верхнего уровня — та же форма, что у серверной шапки. */
const IMPORT_LINE = /^import\s+(.+)$/
const FROM_LINE = /^from\s+[.\w]+\s+import\s+(.+)$/

/**
 * Имена, которые в этой тетради связаны импортом.
 *
 * `import numpy as np` даёт `np`, `import pandas` — `pandas`,
 * `import matplotlib.pyplot as plt` — `plt`, `from sklearn import
 * linear_model` — `linear_model`. Считается по тексту, без разбора: это
 * подсказка о том, чего спрашивать МОЖНО, и ошибиться она может только в
 * сторону лишнего имени в списке.
 *
 * Имена из `from … import …` попадают сюда наравне с модулями, хотя среди них
 * бывают и классы (`from pandas import DataFrame`). Отличить одно от другого
 * по тексту нельзя, а цена ошибки ничтожна: человек навёл на имя, которое сам
 * же импортировал, и получил про него справку — ровно то, чего он хотел.
 */
export function moduleAliases(sources: readonly string[]): Set<string> {
  const found = new Set<string>()
  for (const source of sources) {
    if (typeof source !== 'string' || !source.includes('import')) continue
    // Ячейка на чужом языке (`%%bash`) — не Python, и имён в ней нет.
    if (/^\s*%%/.test(source)) continue
    for (const row of source.split('\n')) {
      const line = row.trim()
      if (line !== row.replace(/\s+$/, '')) continue // импорт с отступом — внутри try/функции
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
        // `import a.b.c` связывает `a`; `import a.b as x` — `x`.
        const name = words.length > 1 ? bound : bound.split('.')[0]
        if (/^[A-Za-z_]\w*$/.test(name)) found.add(name)
      }
    }
  }
  return found
}
