/**
 * Fields in one row stand on one line, whatever their captions.
 *
 * 21 Oct 2026, the owner: on Resources the class memory and the cores stood
 * level, but below them "live kernels at most" and "stop after" did not,
 * because the first caption takes two lines, and the submissions' rate during
 * classes the same. Measured in headless Chrome before the fix, at 1440 to
 * 390 px, in Russian and in English, light and dark: 88 of 320 lines of
 * fields with a box 20 px below its neighbours' — Resources (personal
 * notebooks, classes on machines, files), the connect-a-machine dialog, the
 * Oracle's limits — and the new class form's fallback box standing at its
 * neighbour's caption, not at its control. The review found two more that
 * survey had not counted, its boxes being only the panel's framed inputs: the
 * competition editor's limit tiles (bare number inputs in frames; "Submissions
 * a day" wraps at 1280 px) and a course's row form (its Russian title caption
 * is wider than the 200 px the title keeps beside the day).
 *
 * What these pin: the rule's arithmetic (admin/ui/field-rows.ts · lowering);
 * the action itself on a row drawn the way a browser lays it out (which
 * child is a caption, what is lowered, in layout pixels, when it levels
 * again); and that every row of the settings forms that stands captioned
 * fields side by side carries it, read from the components' own syntax tree
 * (svelte/compiler), so a row added later without it fails here rather than
 * in the owner's eyes. The class form's grid has fixed columns and says the
 * same rule in CSS (subgrid). Whether the boxes really share a top is the
 * browser's to say: the live measurement of the phase stands beside these.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from 'svelte/compiler'
import { levelFields, lowering } from '../web/src/admin/ui/field-rows.js'

function read(rel: string): string {
  return fs.readFileSync(path.resolve(import.meta.dirname, '..', rel), 'utf8')
}

/* ------------------------------------------------------------ the rule */

test('a caption of two lines lowers its neighbours by the line it adds, so the boxes share a top', () => {
  // Live kernels at most, two lines over its box (20 + 20 + 6), beside stop after (20 + 6).
  assert.deepEqual(lowering([{ top: 0, caption: 46 }, { top: 0, caption: 26 }]), [0, 20])
  // The submissions' rate during classes, last of three.
  assert.deepEqual(lowering([{ top: 0, caption: 26 }, { top: 0, caption: 26 }, { top: 0, caption: 46 }]), [20, 20, 0])
})

test('a child with no caption stands on the boxes\' top, not on the captions\'', () => {
  // The note beside those two: it used to be 26 px down by hand, beside the shorter caption's box.
  assert.deepEqual(lowering([{ top: 0, caption: 46 }, { top: 0, caption: 26 }, { top: 0, caption: 0 }]), [0, 20, 46])
  // The per-notebook estimate beside two one-line captions: where the hand put it, 26 px.
  assert.deepEqual(lowering([{ top: 0, caption: 26 }, { top: 0, caption: 26 }, { top: 0, caption: 0 }]), [0, 0, 26])
})

test('a row that stood level does not move, and nor does a child alone in its line', () => {
  assert.deepEqual(lowering([{ top: 0, caption: 26 }, { top: 0, caption: 26 }, { top: 0, caption: 26 }]), [0, 0, 0])
  // A phone: the row is a column, one child per line, a caption of two lines among them.
  assert.deepEqual(lowering([{ top: 0, caption: 26 }, { top: 92, caption: 46 }, { top: 204, caption: 0 }]), [0, 0, 0])
  assert.deepEqual(lowering([]), [])
})

test('each line of a wrapped row levels on its own', () => {
  // 1024 px, English: the file cap and the class files' rate on the first line, the submissions' rate and a note on the second.
  assert.deepEqual(
    lowering([{ top: 0, caption: 26 }, { top: 0, caption: 46 }, { top: 112, caption: 46 }, { top: 112, caption: 0 }]),
    [20, 0, 0, 46],
  )
  // Tops a fraction apart are one line (layout rounds); a line apart are two.
  assert.deepEqual(lowering([{ top: 10, caption: 26 }, { top: 10.6, caption: 46 }]), [20, 0])
  assert.deepEqual(lowering([{ top: 10, caption: 26 }, { top: 40, caption: 46 }]), [0, 0])
})

/* ------------------------------------------------------------ the action */

/**
 * A box as layout puts it, in layout px, with nothing lowered: the action
 * takes its own margins off before it measures, so this is all it ever reads.
 */
interface Box {
  top: number
  height: number
  width?: number
  /** In the panel's caption voice (.admin-label). */
  label?: boolean
  /** Not drawn (display: none): no rects at all. */
  hidden?: boolean
  children?: Box[]
}

/** What one test's page holds: the observers, frames and fonts the action asked for. */
interface Page {
  /** An ancestor's transform: a dialog entering from 97 % of its size. */
  scale: number
  frames: Map<number, () => void>
  requested: number
  cancelled: number[]
  resize: Array<{ callback: () => void; observed: unknown[]; disconnected: boolean }>
  mutation: Array<{ callback: () => void; observed: Array<{ target: unknown; options: unknown }>; disconnected: boolean }>
  /** The web fonts arrive. */
  fontsArrive: () => void
}

/** An element, reduced to what the action reads of it and writes to it. */
class Drawn {
  readonly children: Drawn[] = []
  parent: Drawn | null = null
  readonly written = new Map<string, string>()
  readonly style = {
    setProperty: (name: string, value: string): void => {
      this.written.set(name, value)
    },
    removeProperty: (name: string): void => {
      this.written.delete(name)
    },
  }

  constructor(
    readonly box: Box,
    readonly page: Page,
  ) {}

  get firstElementChild(): Drawn | null {
    return this.children[0] ?? null
  }

  get nextElementSibling(): Drawn | null {
    const siblings = this.parent?.children ?? []
    return siblings[siblings.indexOf(this) + 1] ?? null
  }

  matches(selector: string): boolean {
    assert.equal(selector, '.admin-label', 'the action asks of an element only whether it is in the caption voice')
    return this.box.label === true
  }

  querySelector(selector: string): Drawn | null {
    assert.equal(selector, ':scope > .admin-label', 'and of its children only the same')
    return this.children.find((child) => child.box.label === true) ?? null
  }

  getClientRects(): unknown[] {
    return this.box.hidden ? [] : [this.getBoundingClientRect()]
  }

  getBoundingClientRect(): { top: number; bottom: number; width: number; height: number } {
    const { scale } = this.page
    if (this.box.hidden) return { top: 0, bottom: 0, width: 0, height: 0 }
    const { top, height, width = 0 } = this.box
    return { top: top * scale, bottom: (top + height) * scale, width: width * scale, height: height * scale }
  }

  get offsetWidth(): number {
    return this.box.hidden ? 0 : (this.box.width ?? 0)
  }

  /** The top margin the action wrote; '' — none. */
  get lowered(): string {
    return this.written.get('margin-top') ?? ''
  }
}

/** A fresh page for one test: the globals the action reaches for, recorded. */
function page(scale = 1): Page {
  let fontsArrive = (): void => undefined
  const ready = new Promise<void>((resolve) => (fontsArrive = resolve))
  const state: Page = { scale, frames: new Map(), requested: 0, cancelled: [], resize: [], mutation: [], fontsArrive: () => fontsArrive() }
  Object.assign(globalThis, {
    HTMLElement: Drawn,
    document: { fonts: { ready } },
    requestAnimationFrame: (callback: () => void): number => {
      state.requested += 1
      state.frames.set(state.requested, callback)
      return state.requested
    },
    cancelAnimationFrame: (id: number): void => {
      if (state.frames.delete(id)) state.cancelled.push(id)
    },
    ResizeObserver: class {
      readonly record: Page['resize'][number]
      constructor(callback: () => void) {
        this.record = { callback, observed: [], disconnected: false }
        state.resize.push(this.record)
      }
      observe(target: unknown): void {
        this.record.observed.push(target)
      }
      disconnect(): void {
        this.record.disconnected = true
      }
    },
    MutationObserver: class {
      readonly record: Page['mutation'][number]
      constructor(callback: () => void) {
        this.record = { callback, observed: [], disconnected: false }
        state.mutation.push(this.record)
      }
      observe(target: unknown, options: unknown): void {
        this.record.observed.push({ target, options })
      }
      disconnect(): void {
        this.record.disconnected = true
      }
    },
  })
  return state
}

/** The frames waiting, run as the browser runs them before its next paint. */
function nextFrame(state: Page): void {
  const due = [...state.frames.values()]
  state.frames.clear()
  for (const run of due) run()
}

function draw(box: Box, state: Page, parent: Drawn | null = null): Drawn {
  const element = new Drawn(box, state)
  element.parent = parent
  for (const child of box.children ?? []) element.children.push(draw(child, state, element))
  return element
}

const level = (row: Drawn, options?: { framed?: boolean }) => levelFields(row as unknown as HTMLElement, options)
const lowered = (elements: Drawn[]): string[] => elements.map((one) => one.lowered)

/** A field as the panel draws it: a caption of `lines` lines (20 px each), 6 px under it, its 40 px box. */
function field(top: number, lines: number): Box {
  return { top, height: lines * 20 + 6 + 40, width: 200, children: [{ top, height: lines * 20, label: true }, { top: top + lines * 20 + 6, height: 40 }] }
}

/** The same field after its caption rewrapped to `lines` lines. */
function rewrap(box: Box, lines: number): void {
  const [caption, under] = box.children ?? []
  caption.height = lines * 20
  under.top = box.top + lines * 20 + 6
}

/** Words beside the fields, with no element of their own: a note. */
const note = (top: number): Box => ({ top, height: 40, width: 220 })

const row = (children: Box[], top = 0): Box => ({ top, height: 92, width: 900, children })

test('the action lowers the shorter caption\'s field to its neighbour\'s box, and a note to the boxes\' top', () => {
  // Live kernels at most (two lines), stop after (one), and the note beside them.
  const drawn = draw(row([field(0, 2), field(0, 1), note(0)]), page())
  level(drawn)
  assert.deepEqual(lowered(drawn.children), ['', '20px', '46px'])
})

test('measured through a dialog\'s entrance at 97 %, far down the page, it lowers by whole layout pixels', () => {
  // The connect dialog's row 2 365 px down the page: unscaled it came out 19.4 px, and the float noise of the division reads 20.000000000000092.
  const drawn = draw(row([field(2365, 2), field(2365, 1), note(2365)], 2365), page(0.97))
  level(drawn)
  assert.deepEqual(lowered(drawn.children), ['', '20px', '46px'])
})

test('a word in the caption voice beside its value on one line is no caption: that readout stands at the boxes\' top', () => {
  // The GPU share beside the per-card field: its word in the label voice and its gauge on one line, the gauge's top a little lower.
  const readout: Box = { top: 0, height: 40, width: 260, children: [{ top: 0, height: 20, label: true }, { top: 4, height: 16 }, { top: 4, height: 16 }] }
  const drawn = draw(row([field(0, 1), readout]), page())
  level(drawn)
  assert.deepEqual(lowered(drawn.children), ['', '26px'])
})

test('a child not drawn stands on no line, and a child alone on its line keeps its place', () => {
  // A phone: one field per line, the middle one's caption two lines; a hidden field among them.
  const hidden: Box = { ...field(0, 2), hidden: true }
  const drawn = draw({ top: 0, height: 320, width: 358, children: [field(0, 1), hidden, field(92, 2), note(204)] }, page())
  level(drawn)
  assert.deepEqual(lowered(drawn.children), ['', '', '', ''])
})

test('framed fields keep their frames on the line and lower what stands under the shorter captions', () => {
  // The competition's limits at 1280 px in English: 177 px tiles, 1 px frame and 12 px inside, "Submissions a day" in two lines.
  const tile = (lines: number): Box => ({
    top: 0,
    height: 13 + lines * 20 + 6 + 32 + 13,
    width: 177,
    children: [{ top: 13, height: lines * 20, label: true }, { top: 13 + lines * 20 + 6, height: 32 }],
  })
  // A frame with no caption over its contents keeps them where they are.
  const bare: Box = { top: 0, height: 80, width: 177, children: [{ top: 13, height: 32 }] }
  const drawn = draw(row([tile(1), tile(1), tile(1), tile(2), bare]), page())
  level(drawn, { framed: true })
  assert.deepEqual(lowered(drawn.children), ['', '', '', '', ''], 'no frame leaves its line')
  assert.deepEqual(lowered(drawn.children.map((one) => one.children[0])), ['', '', '', '', ''], 'the captions stay at the frames\' top')
  assert.deepEqual(lowered(drawn.children.slice(0, 4).map((one) => one.children[1])), ['20px', '20px', '20px', ''])
})

test('a caption rewrapped while someone types is levelled at once; a new width waits for one frame', () => {
  const state = page()
  const spec = row([field(0, 2), field(0, 1)])
  const drawn = draw(spec, state)
  level(drawn)
  assert.deepEqual(lowered(drawn.children), ['', '20px'])
  // Attributes are not watched: the margins it writes are attributes, and would level the row again for each.
  assert.deepEqual(state.mutation[0].observed, [{ target: drawn, options: { childList: true, subtree: true, characterData: true } }])
  assert.deepEqual(state.resize[0].observed, [drawn])

  // A "was 4" mark beside the second caption wraps it to two lines: the mutation observer levels before the paint.
  rewrap(spec.children![1], 2)
  state.mutation[0].callback()
  assert.deepEqual(lowered(drawn.children), ['', ''])
  assert.equal(state.requested, 0, 'no frame waited for')

  // The window widens and the first caption fits one line: not inside the resize observer's callback, once in the next frame.
  rewrap(spec.children![0], 1)
  state.resize[0].callback()
  state.resize[0].callback()
  assert.deepEqual(lowered(drawn.children), ['', ''])
  assert.equal(state.requested, 1, 'two resizes, one frame')
  nextFrame(state)
  assert.deepEqual(lowered(drawn.children), ['20px', ''])
})

test('a web font arriving levels the row in the next frame; a row that left the page schedules nothing', async () => {
  const state = page()
  const spec = row([field(0, 2), field(0, 1)])
  const drawn = draw(spec, state)
  const action = level(drawn)
  // The captions rewrap in the font that arrived, with no mutation to say so.
  rewrap(spec.children![0], 1)
  state.fontsArrive()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.requested, 1)
  nextFrame(state)
  assert.deepEqual(lowered(drawn.children), ['', ''])

  const other = page()
  const gone = draw(row([field(0, 2), field(0, 1)]), other)
  const left = level(gone)
  other.resize[0].callback()
  left.destroy()
  assert.equal(other.resize[0].disconnected, true)
  assert.equal(other.mutation[0].disconnected, true)
  assert.deepEqual(other.cancelled, [1], 'the frame it was waiting for is dropped')
  other.fontsArrive()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(other.requested, 1, 'nothing scheduled after it left')
  action.destroy()
})

/* ------------------------------------------------------------ the forms */

/**
 * The panel's forms that stand fields side by side under captions of
 * different heights: Resources (its tab, the where-it-runs block, the connect
 * dialog), the Oracle, the competition editor (a live competition's Settings
 * tab too), a course's row form; and the class forms, whose fields come from
 * Resources and whose own rows stand none side by side today.
 */
const FORMS = [
  'web/src/admin/screens/ResourcesTab.svelte',
  'web/src/admin/ui/ConnectMachine.svelte',
  'web/src/admin/screens/Oracle.svelte',
  'web/src/admin/ui/Resources.svelte',
  'web/src/admin/screens/competitions/Editor.svelte',
  'web/src/admin/screens/Courses.svelte',
  'web/src/admin/screens/NewSeminar.svelte',
  'web/src/admin/screens/Seminars.svelte',
]

/** The panel's own control components, and the classes its boxes are drawn with. */
const CONTROL_COMPONENTS = new Set(['Choice', 'Check'])
const BOX_CLASSES = new Set(['admin-affix', 'field', 'pl-seg'])

type Node = { type: string; [key: string]: any }

interface FieldRow {
  text: string
  layout: string[]
  /** The use:levelFields directive as written; '' — none. */
  directive: string
  /** Its fields are frames holding their captions. */
  framed: boolean
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((one) => one && typeof one === 'object' && 'type' in one && walk(one, visit))
    else if (value && typeof value === 'object' && 'type' in value) walk(value, visit)
  }
}

/** Every element of a component that stands two or more things side by side, one of them a captioned field. */
function fieldRows(source: string): FieldRow[] {
  const ast = parse(source, { modern: true }) as unknown as Node
  // A class written through a constant (the editor's HEAD and TILE, the new class form's CAP) is still that class.
  const constants = new Map<string, string>()
  for (const statement of ast.instance?.content.body ?? []) {
    if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const') continue
    for (const one of statement.declarations) {
      if (one.id.type === 'Identifier' && one.init?.type === 'Literal' && typeof one.init.value === 'string') constants.set(one.id.name, one.init.value)
    }
  }
  const snippets = new Map<string, Node>()
  walk(ast.fragment, (node) => {
    if (node.type === 'SnippetBlock') snippets.set(node.expression.name, node)
  })

  const classes = (node: Node): string[] => {
    const attribute = (node.attributes ?? []).find((one: Node) => one.type === 'Attribute' && one.name === 'class')
    if (!attribute) return []
    const text = source.slice(attribute.start, attribute.end).replace(/^class=/, '')
    return text.replace(/\b[A-Z][A-Z_]+\b/g, (name) => constants.get(name) ?? name).split(/[\s"'`{}(),]+/).filter(Boolean)
  }
  /** What a node puts into its parent, through the blocks that draw it or not; a snippet call, what its snippet draws. */
  const items = (nodes: Node[]): Node[] =>
    nodes.flatMap((node) => {
      if (node.type === 'IfBlock') return [...items(node.consequent.nodes), ...(node.alternate ? items(node.alternate.nodes) : [])]
      if (node.type === 'EachBlock') return items(node.body.nodes)
      if (node.type === 'KeyBlock') return items(node.fragment.nodes)
      if (node.type === 'RegularElement' || node.type === 'RenderTag' || node.type === 'Component') return [node]
      return []
    })
  const drawn = (node: Node): Node | undefined => {
    if (node.type !== 'RenderTag') return node
    const snippet = snippets.get(node.expression.callee?.name)
    return snippet ? items(snippet.body.nodes)[0] : undefined
  }
  const own = (node: Node | undefined): Node[] => (node?.type === 'RegularElement' ? items(node.fragment.nodes) : [])
  const voiced = (node: Node | undefined): boolean => node?.type === 'RegularElement' && classes(node).includes('admin-label')
  /** A caption: in the panel's label voice, or holding it beside a "was …" mark. */
  const isCaption = (node: Node): boolean => {
    const element = drawn(node)
    return voiced(element) || own(element).some(voiced)
  }
  const isControl = (node: Node): boolean => {
    if (node.type === 'Component') return CONTROL_COMPONENTS.has(node.name)
    if (node.type !== 'RegularElement') return false
    if (['input', 'select', 'textarea'].includes(node.name)) return true
    const role = (node.attributes ?? []).find((one: Node) => one.type === 'Attribute' && one.name === 'role')
    if (node.name === 'button' && role && source.slice(role.start, role.end) === 'role="switch"') return true
    return classes(node).some((one) => BOX_CLASSES.has(one))
  }
  /** What stands under a caption: a control, or an element holding one among its own children. */
  const isBox = (node: Node): boolean => {
    const element = drawn(node)
    return element !== undefined && (isControl(element) || own(element).some(isControl))
  }
  /** A field: a caption over a box. */
  const fieldOf = (node: Node): Node | null => {
    const element = drawn(node)
    const [caption, under] = own(element)
    return element && caption && under && isCaption(caption) && isBox(under) ? element : null
  }

  const rows: FieldRow[] = []
  walk(ast.fragment, (node) => {
    if (node.type !== 'RegularElement') return
    const layout = classes(node)
    const sideBySide = ['flex', 'inline-flex', 'flex-wrap', 'grid', 'pl-fields'].some((one) => layout.includes(one)) && !layout.includes('flex-col')
    const children = items(node.fragment.nodes)
    const fields = children.map(fieldOf).filter((one): one is Node => one !== null)
    if (!sideBySide || children.length < 2 || fields.length === 0) return
    const directive = (node.attributes ?? []).find((one: Node) => one.type === 'UseDirective' && one.name === 'levelFields')
    rows.push({
      text: source.slice(node.start, Math.min(node.end, node.start + 160)).replace(/\s+/g, ' '),
      layout,
      directive: directive ? source.slice(directive.start, directive.end) : '',
      framed: fields.every((one) => classes(one).includes('border')),
    })
  })
  return rows
}

test('every row of captioned fields in the settings forms carries the rule, framed where its fields are frames', () => {
  const found: Record<string, number> = {}
  const framed: string[] = []
  for (const rel of FORMS) {
    const rows = fieldRows(read(rel))
    found[rel] = rows.length
    for (const row of rows) {
      // The class form's grid has fixed columns and says the rule in CSS: its own test is the last one here.
      if (row.layout.includes('pl-fields')) continue
      assert.ok(row.directive, `${rel}: a row of fields without use:levelFields — ${row.text}`)
      if (row.framed) {
        framed.push(`${rel} ${row.text}`)
        assert.equal(row.directive, 'use:levelFields={{ framed: true }}', `${rel}: frames lowered whole, out of their line — ${row.text}`)
      } else {
        assert.equal(row.directive, 'use:levelFields', `${rel}: ${row.text}`)
      }
    }
  }
  // The rows the owner saw, the ones the review found, and the rest of each form: none of them may slip out of the walk.
  assert.deepEqual(found, {
    'web/src/admin/screens/ResourcesTab.svelte': 10,
    'web/src/admin/ui/ConnectMachine.svelte': 1,
    'web/src/admin/screens/Oracle.svelte': 2,
    'web/src/admin/ui/Resources.svelte': 1,
    // The hidden test's path and what is there, the limit tiles, the dates.
    'web/src/admin/screens/competitions/Editor.svelte': 3,
    'web/src/admin/screens/Courses.svelte': 1,
    'web/src/admin/screens/NewSeminar.svelte': 0,
    'web/src/admin/screens/Seminars.svelte': 0,
  })
  // The one framed row is the competition's limits: TILE frames, the time's caption first.
  assert.equal(framed.length, 1, framed.join('\n'))
  assert.match(framed[0], /^web\/src\/admin\/screens\/competitions\/Editor\.svelte <div [^>]*use:levelFields=\{\{ framed: true \}\}> <label class="\{TILE\}/)
})

test('the rule comes from its one module, and no box is lowered by hand any more', () => {
  for (const rel of FORMS) {
    const source = read(rel)
    if (source.includes('use:levelFields')) assert.match(source, /import \{ levelFields \} from '@\/admin\/ui\/field-rows'/, rel)
    // 26 px was one caption line and its gap: true only while every caption beside the box was one line.
    assert.doesNotMatch(source, /mt-\[26px\]/, rel)
  }
})

test('the class form\'s grid shares caption, control and note rows between its columns, each control at its own size', () => {
  const source = read('web/src/admin/ui/Resources.svelte')
  const wide = source.slice(source.indexOf('@container (min-width: 720px)'), source.indexOf('</style>'))
  assert.match(wide, /\.pl-fields \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);\s*\}/)
  assert.match(wide, /\.pl-fields > div \{\s*display: grid;\s*grid-row: span 3;\s*grid-template-rows: subgrid;\s*row-gap: 0;\s*\}/)
  // A grid item stretches to its cell: the failover's segmented control ran its frame across the column, 40 px high.
  assert.match(wide, /\.pl-fields > div > :not\(\.admin-label\):not\(\.admin-meta\) \{\s*grid-row: 2;\s*align-self: start;\s*\}/)
  assert.match(wide, /\.pl-fields > div > \.pl-seg \{\s*justify-self: start;\s*\}/)
  assert.match(wide, /\.pl-fields > div > \.admin-label \{\s*grid-row: 1;\s*\}/)
  assert.match(wide, /\.pl-fields > div > \.admin-meta \{\s*grid-row: 3;\s*\}/)
  // The segmented controls hug their buttons there, as they did before the grid shared its rows.
  assert.match(wide, /\.pl-seg-wide \{\s*width: auto;\s*display: inline-flex;\s*\}/)
  // One column below 720 px of its own width (the 640 px class window, a phone): nothing to share there.
  const narrow = source.slice(source.indexOf('<style>'), source.indexOf('@container (min-width: 720px)'))
  assert.doesNotMatch(narrow, /subgrid/)
  // Three rows hold every field of the grid: a caption or none, one control, one note under it.
  const ast = parse(source, { modern: true }) as unknown as Node
  let grid: Node | undefined
  walk(ast.fragment, (node) => {
    if (!grid && node.type === 'RegularElement' && /class="pl-fields"/.test(source.slice(node.start, node.end).slice(0, 40))) grid = node
  })
  assert.ok(grid, 'the grid is drawn')
  const blocks = (nodes: Node[]): Node[] =>
    nodes.flatMap((node) => (node.type === 'IfBlock' ? [...blocks(node.consequent.nodes), ...(node.alternate ? blocks(node.alternate.nodes) : [])] : node.type === 'RegularElement' ? [node] : []))
  const classOf = (node: Node): string => {
    const attribute = (node.attributes ?? []).find((one: Node) => one.type === 'Attribute' && one.name === 'class')
    return attribute ? source.slice(attribute.start, attribute.end) : ''
  }
  const fields = blocks(grid.fragment.nodes)
  assert.equal(fields.length, 4, 'the fallback, the failover and the council\'s two')
  for (const one of fields) {
    const parts = blocks(one.fragment.nodes).map(classOf)
    const captions = parts.filter((part) => /\badmin-label\b/.test(part))
    const notes = parts.filter((part) => /\badmin-meta\b/.test(part))
    assert.ok(parts.length <= 3 && captions.length <= 1 && notes.length === 1, `caption, control, note: ${parts.join(' / ')}`)
    assert.ok(captions.length === 0 || /\badmin-label\b/.test(parts[0]), 'a caption comes first')
    assert.match(parts[parts.length - 1], /\badmin-meta\b/, 'the note comes last')
  }
})
