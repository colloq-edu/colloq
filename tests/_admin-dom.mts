/**
 * Just enough of a browser to mount the panel's screens in a test and watch
 * what they draw while their requests are on the way and after.
 *
 * The suite has no DOM library and installs none, and the screens' first
 * fetch runs in `onMount`, which server rendering never calls: a test of
 * "the placeholder stands while the list is asked, and goes when it lands"
 * needs the client build running against a document. This is that document,
 * a small one: nodes in a tree, attributes, a class list and a style map,
 * events that bubble (Svelte delegates them to the root), and a selector
 * matcher for the tests' own questions — tag, #id, .class and [attr] /
 * [attr="value"] compounds joined by spaces or `>`. Layout is not modelled:
 * every box measures zero.
 *
 * `installDom()` puts it on globalThis and registers the module hooks
 * (tests/_svelte-hooks.mjs) that compile `.svelte` files for the browser.
 */
import { register } from 'node:module'
import path from 'node:path'

/* ---------------------------------------------------------------- events */

type Listener = { fn: EventListenerOrEventListenerObject; capture: boolean; once: boolean }

class Target {
  #listeners = new Map<string, Listener[]>()

  addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    if (!fn) return
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
    const once = typeof options === 'object' && Boolean(options?.once)
    const list = this.#listeners.get(type) ?? []
    if (list.some((one) => one.fn === fn && one.capture === capture)) return
    list.push({ fn, capture, once })
    this.#listeners.set(type, list)
  }

  removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
    const list = this.#listeners.get(type)
    if (!list) return
    this.#listeners.set(type, list.filter((one) => !(one.fn === fn && one.capture === capture)))
  }

  /** Calls this node's listeners for one phase; false once propagation was stopped. */
  _invoke(event: Event, capture: boolean): void {
    const list = this.#listeners.get(event.type)
    if (!list) return
    for (const one of [...list]) {
      if (one.capture !== capture) continue
      if (one.once) this.removeEventListener(event.type, one.fn, { capture })
      Object.defineProperty(event, 'currentTarget', { value: this, configurable: true })
      if (typeof one.fn === 'function') one.fn.call(this, event)
      else one.fn.handleEvent(event)
    }
  }

  /** The path an event takes from here: this node, its ancestors, and the window above a document. */
  _path(): Target[] {
    const path: Target[] = []
    let at: Target | null = this
    while (at) {
      path.push(at)
      at = at instanceof FakeNode ? (at.parentNode ?? (at instanceof FakeDocument ? fakeWindow : null)) : null
    }
    return path
  }

  dispatchEvent(event: Event): boolean {
    const path = this._path()
    Object.defineProperty(event, 'target', { value: this, configurable: true })
    Object.defineProperty(event, 'composedPath', { value: () => path, configurable: true })
    for (let i = path.length - 1; i >= 0; i -= 1) {
      path[i]._invoke(event, true)
      if (event.cancelBubble) return !event.defaultPrevented
    }
    for (let i = 0; i < path.length; i += 1) {
      path[i]._invoke(event, false)
      if (event.cancelBubble || (!event.bubbles && i === 0)) break
    }
    Reflect.deleteProperty(event, 'currentTarget')
    return !event.defaultPrevented
  }
}

/* ----------------------------------------------------------------- nodes */

class FakeNode extends Target {
  static ELEMENT_NODE = 1
  static TEXT_NODE = 3
  static COMMENT_NODE = 8
  static DOCUMENT_NODE = 9
  static DOCUMENT_FRAGMENT_NODE = 11

  nodeType = 0
  nodeName = ''
  parentNode: FakeNode | null = null
  _kids: FakeNode[] = []

  get ownerDocument(): FakeDocument {
    return fakeDocument
  }
  get firstChild(): FakeNode | null {
    return this._kids[0] ?? null
  }
  get lastChild(): FakeNode | null {
    return this._kids[this._kids.length - 1] ?? null
  }
  get nextSibling(): FakeNode | null {
    const kids = this.parentNode?._kids
    return kids ? (kids[kids.indexOf(this) + 1] ?? null) : null
  }
  get previousSibling(): FakeNode | null {
    const kids = this.parentNode?._kids
    return kids ? (kids[kids.indexOf(this) - 1] ?? null) : null
  }
  get childNodes(): FakeNode[] {
    return [...this._kids]
  }
  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null
  }
  get isConnected(): boolean {
    return this.getRootNode() === fakeDocument
  }
  get nodeValue(): string | null {
    return null
  }
  set nodeValue(_value: string | null) {}

  get textContent(): string {
    return this._kids.map((kid) => kid.textContent).join('')
  }
  set textContent(value: string) {
    for (const kid of [...this._kids]) this.removeChild(kid)
    if (value) this.appendChild(fakeDocument.createTextNode(String(value)))
  }

  hasChildNodes(): boolean {
    return this._kids.length > 0
  }
  getRootNode(): FakeNode {
    let at: FakeNode = this
    while (at.parentNode) at = at.parentNode
    return at
  }
  contains(other: FakeNode | null): boolean {
    for (let at = other; at; at = at.parentNode) if (at === this) return true
    return false
  }

  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    if (node instanceof FakeFragment) {
      for (const kid of [...node._kids]) this.insertBefore(kid, ref)
      return node
    }
    node.parentNode?.removeChild(node)
    const at = ref ? this._kids.indexOf(ref) : this._kids.length
    if (at < 0) throw new Error('insertBefore: the reference is not a child of this node')
    this._kids.splice(at, 0, node)
    node.parentNode = this
    return node
  }
  appendChild<T extends FakeNode>(node: T): T {
    return this.insertBefore(node, null)
  }
  removeChild<T extends FakeNode>(node: T): T {
    const at = this._kids.indexOf(node)
    if (at < 0) throw new Error('removeChild: not a child of this node')
    this._kids.splice(at, 1)
    node.parentNode = null
    return node
  }
  replaceChild<T extends FakeNode>(node: FakeNode, old: T): T {
    this.insertBefore(node, old)
    return this.removeChild(old)
  }
  append(...nodes: (FakeNode | string)[]): void {
    for (const one of nodes) this.appendChild(asNode(one))
  }
  prepend(...nodes: (FakeNode | string)[]): void {
    const first = this.firstChild
    for (const one of nodes) this.insertBefore(asNode(one), first)
  }
  before(...nodes: (FakeNode | string)[]): void {
    const parent = this.parentNode
    if (!parent) return
    for (const one of nodes) parent.insertBefore(asNode(one), this)
  }
  after(...nodes: (FakeNode | string)[]): void {
    const parent = this.parentNode
    if (!parent) return
    const next = this.nextSibling
    for (const one of nodes) parent.insertBefore(asNode(one), next)
  }
  remove(): void {
    this.parentNode?.removeChild(this)
  }
  replaceWith(...nodes: (FakeNode | string)[]): void {
    const parent = this.parentNode
    if (!parent) return
    const next = this.nextSibling
    parent.removeChild(this)
    for (const one of nodes) parent.insertBefore(asNode(one), next)
  }
  cloneNode(deep = false): FakeNode {
    const copy = this._shallow()
    if (deep) for (const kid of this._kids) copy.appendChild(kid.cloneNode(true))
    return copy
  }
  _shallow(): FakeNode {
    throw new Error(`cannot clone ${this.nodeName}`)
  }
}

function asNode(one: FakeNode | string): FakeNode {
  return typeof one === 'string' ? fakeDocument.createTextNode(one) : one
}

class FakeCharacterData extends FakeNode {
  data: string
  constructor(data: string) {
    super()
    this.data = data
  }
  override get nodeValue(): string {
    return this.data
  }
  override set nodeValue(value: string | null) {
    this.data = String(value ?? '')
  }
  override get textContent(): string {
    return this.data
  }
  override set textContent(value: string) {
    this.data = String(value)
  }
  get length(): number {
    return this.data.length
  }
}

class FakeText extends FakeCharacterData {
  override nodeType = 3
  override nodeName = '#text'
  override _shallow(): FakeNode {
    return new FakeText(this.data)
  }
}

class FakeComment extends FakeCharacterData {
  override nodeType = 8
  override nodeName = '#comment'
  override _shallow(): FakeNode {
    return new FakeComment(this.data)
  }
}

class FakeFragment extends FakeNode {
  override nodeType = 11
  override nodeName = '#document-fragment'
  override _shallow(): FakeNode {
    return new FakeFragment()
  }
  querySelector(selector: string): FakeElement | null {
    return queryAll(this, selector)[0] ?? null
  }
  querySelectorAll(selector: string): FakeElement[] {
    return queryAll(this, selector)
  }
}

/* -------------------------------------------------------------- elements */

class FakeStyle {
  #props = new Map<string, string>()
  get cssText(): string {
    return [...this.#props].map(([key, value]) => `${key}: ${value};`).join(' ')
  }
  set cssText(text: string) {
    this.#props.clear()
    for (const part of String(text).split(';')) {
      const at = part.indexOf(':')
      if (at > 0) this.#props.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
    }
  }
  setProperty(key: string, value: string | null): void {
    if (value === null || value === '') this.#props.delete(key)
    else this.#props.set(key, String(value))
  }
  removeProperty(key: string): string {
    const was = this.#props.get(key) ?? ''
    this.#props.delete(key)
    return was
  }
  getPropertyValue(key: string): string {
    return this.#props.get(key) ?? ''
  }
}

class FakeClassList {
  constructor(private readonly element: FakeElement) {}
  #read(): string[] {
    return (this.element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
  }
  #write(list: string[]): void {
    this.element.setAttribute('class', list.join(' '))
  }
  contains(name: string): boolean {
    return this.#read().includes(name)
  }
  add(...names: string[]): void {
    this.#write([...new Set([...this.#read(), ...names])])
  }
  remove(...names: string[]): void {
    this.#write(this.#read().filter((one) => !names.includes(one)))
  }
  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.contains(name)
    if (on) this.add(name)
    else this.remove(name)
    return on
  }
}

class FakeElement extends FakeNode {
  override nodeType = 1
  readonly localName: string
  readonly namespaceURI: string
  _attrs = new Map<string, string>()
  style = new FakeStyle()
  classList: FakeClassList

  constructor(name: string, namespace = 'http://www.w3.org/1999/xhtml') {
    super()
    this.namespaceURI = namespace
    const html = namespace === 'http://www.w3.org/1999/xhtml'
    this.localName = html ? name.toLowerCase() : name
    this.nodeName = html ? name.toUpperCase() : name
    this.classList = new FakeClassList(this)
  }
  get tagName(): string {
    return this.nodeName
  }
  get attributes(): { name: string; value: string }[] {
    return [...this._attrs].map(([name, value]) => ({ name, value }))
  }
  getAttribute(name: string): string | null {
    return this._attrs.get(name) ?? null
  }
  setAttribute(name: string, value: unknown): void {
    this._attrs.set(name, String(value))
    if (name === 'style') this.style.cssText = String(value)
  }
  setAttributeNS(_namespace: string | null, name: string, value: unknown): void {
    this.setAttribute(name, value)
  }
  removeAttribute(name: string): void {
    this._attrs.delete(name)
  }
  hasAttribute(name: string): boolean {
    return this._attrs.has(name)
  }
  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(name)
    if (on) this.setAttribute(name, '')
    else this.removeAttribute(name)
    return on
  }
  get className(): string {
    return this.getAttribute('class') ?? ''
  }
  set className(value: string) {
    this.setAttribute('class', value)
  }
  get id(): string {
    return this.getAttribute('id') ?? ''
  }
  set id(value: string) {
    this.setAttribute('id', value)
  }
  get children(): FakeElement[] {
    return this._kids.filter((kid): kid is FakeElement => kid instanceof FakeElement)
  }
  get innerHTML(): string {
    return this._kids.map(serialize).join('')
  }
  set innerHTML(value: string) {
    if (value !== '') throw new Error('the stand-in DOM does not parse HTML')
    this.textContent = ''
  }
  get outerHTML(): string {
    return serialize(this)
  }
  get innerText(): string {
    return this.textContent
  }
  querySelector(selector: string): FakeElement | null {
    return queryAll(this, selector)[0] ?? null
  }
  querySelectorAll(selector: string): FakeElement[] {
    return queryAll(this, selector)
  }
  matches(selector: string): boolean {
    return selector.split(',').some((one) => matchesChain(this, parseChain(one.trim())))
  }
  closest(selector: string): FakeElement | null {
    for (let at: FakeNode | null = this; at; at = at.parentNode) {
      if (at instanceof FakeElement && at.matches(selector)) return at
    }
    return null
  }
  focus(): void {
    fakeDocument.activeElement = this
  }
  blur(): void {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = fakeDocument.body
  }
  click(): void {
    this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }))
  }
  scrollIntoView(): void {}
  scrollTo(): void {}
  getBoundingClientRect(): DOMRectReadOnly {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON() {} } as DOMRectReadOnly
  }
  getClientRects(): DOMRectReadOnly[] {
    return []
  }
  animate(): { cancel(): void; finished: Promise<void>; onfinish: null } {
    return { cancel() {}, finished: Promise.resolve(), onfinish: null }
  }
  override _shallow(): FakeNode {
    const copy = fakeDocument.createElementNS(this.namespaceURI, this.localName)
    for (const [name, value] of this._attrs) copy.setAttribute(name, value)
    return copy
  }
}

/**
 * The HTML element: where the form properties live, so Svelte finds them as
 * setters (it walks the prototypes down to Element for them).
 */
class FakeHTMLElement extends FakeElement {
  #value = ''
  #checked = false
  #selected = false
  readonly content: FakeFragment | null

  constructor(name: string) {
    super(name)
    this.content = this.localName === 'template' ? new FakeFragment() : null
  }
  /** An option's value is its attribute or its text; a select's, its chosen option's. */
  get value(): string {
    if (this.localName === 'option') return this.getAttribute('value') ?? this.textContent
    if (this.localName === 'select') return (this.options.find((one) => one.selected)?.value as string | undefined) ?? ''
    return this.#value
  }
  set value(value: string) {
    if (this.localName === 'option') this.setAttribute('value', value)
    else if (this.localName === 'select') for (const one of this.options) one.selected = one.value === String(value)
    else this.#value = String(value ?? '')
  }
  get checked(): boolean {
    return this.#checked
  }
  set checked(value: boolean) {
    this.#checked = Boolean(value)
  }
  get selected(): boolean {
    return this.#selected
  }
  set selected(value: boolean) {
    this.#selected = Boolean(value)
    // One chosen option in a select that takes one.
    const select = this.closest('select') as FakeHTMLElement | null
    if (value && select && !select.multiple) for (const one of select.options) if (one !== this) one.#selected = false
  }
  get options(): FakeHTMLElement[] {
    return this.localName === 'select' ? (queryAll(this, 'option') as FakeHTMLElement[]) : []
  }
  get multiple(): boolean {
    return this.hasAttribute('multiple')
  }
  set multiple(value: boolean) {
    this.toggleAttribute('multiple', Boolean(value))
  }
  get selectedIndex(): number {
    return this.options.findIndex((one) => one.selected)
  }
  set selectedIndex(index: number) {
    this.options.forEach((one, i) => (one.#selected = i === index))
  }
  get disabled(): boolean {
    return this.hasAttribute('disabled')
  }
  set disabled(value: boolean) {
    this.toggleAttribute('disabled', Boolean(value))
  }
  get hidden(): boolean {
    return this.hasAttribute('hidden')
  }
  set hidden(value: boolean) {
    this.toggleAttribute('hidden', Boolean(value))
  }
  get tabIndex(): number {
    return Number(this.getAttribute('tabindex') ?? -1)
  }
  set tabIndex(value: number) {
    this.setAttribute('tabindex', String(value))
  }
  get dataset(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, value] of this._attrs) {
      if (name.startsWith('data-')) out[name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = value
    }
    return out
  }
  get offsetWidth(): number {
    return 0
  }
  get offsetHeight(): number {
    return 0
  }
}

class FakeDocument extends FakeNode {
  override nodeType = 9
  override nodeName = '#document'
  readonly documentElement: FakeHTMLElement
  readonly head: FakeHTMLElement
  readonly body: FakeHTMLElement
  activeElement: FakeElement | null = null
  visibilityState = 'visible'
  hidden = false
  baseURI = 'http://127.0.0.1/'
  readyState = 'complete'

  constructor() {
    super()
    this.documentElement = new FakeHTMLElement('html')
    this.head = new FakeHTMLElement('head')
    this.body = new FakeHTMLElement('body')
    this.documentElement.append(this.head, this.body)
    this.appendChild(this.documentElement)
    this.activeElement = this.body
  }
  override get ownerDocument(): FakeDocument {
    return this
  }
  createElement(name: string): FakeHTMLElement {
    return new FakeHTMLElement(name)
  }
  createElementNS(namespace: string | null, name: string): FakeElement {
    return !namespace || namespace === 'http://www.w3.org/1999/xhtml' ? new FakeHTMLElement(name) : new FakeElement(name, namespace)
  }
  createTextNode(data: string): FakeText {
    return new FakeText(String(data))
  }
  createComment(data: string): FakeComment {
    return new FakeComment(String(data))
  }
  createDocumentFragment(): FakeFragment {
    return new FakeFragment()
  }
  importNode(node: FakeNode, deep = false): FakeNode {
    return node.cloneNode(deep)
  }
  querySelector(selector: string): FakeElement | null {
    return queryAll(this, selector)[0] ?? null
  }
  querySelectorAll(selector: string): FakeElement[] {
    return queryAll(this, selector)
  }
  getElementById(id: string): FakeElement | null {
    return queryAll(this, `#${id}`)[0] ?? null
  }
  getSelection(): null {
    return null
  }
  execCommand(): boolean {
    return false
  }
}

/* ------------------------------------------------------------- selectors */

type Simple = {
  tag: string | null
  id: string | null
  classes: string[]
  attrs: { name: string; value: string | null }[]
  checked: boolean
  not: Simple[]
}
type Step = { combinator: ' ' | '>'; simple: Simple }

function parseSimple(text: string): Simple {
  const simple: Simple = { tag: null, id: null, classes: [], attrs: [], checked: false, not: [] }
  const rest = text.replace(/:not\(([^)]*)\)/g, (_all, inner: string) => {
    simple.not.push(parseSimple(inner))
    return ''
  })
  const pattern = /:checked|^([a-zA-Z][\w-]*)|#([\w-]+)|\.((?:\\.|[\w-])+)|\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g
  for (const match of rest.matchAll(pattern)) {
    if (match[0] === ':checked') simple.checked = true
    else if (match[1]) simple.tag = match[1].toLowerCase()
    else if (match[2]) simple.id = match[2]
    else if (match[3]) simple.classes.push(match[3].replace(/\\(.)/g, '$1'))
    else if (match[4]) simple.attrs.push({ name: match[4], value: match[5] ?? null })
  }
  return simple
}

function parseChain(selector: string): Step[] {
  const tokens = selector.replace(/\s*>\s*/g, ' > ').trim().split(/\s+/)
  const steps: Step[] = []
  let combinator: ' ' | '>' = ' '
  for (const token of tokens) {
    if (token === '>') {
      combinator = '>'
      continue
    }
    steps.push({ combinator, simple: parseSimple(token) })
    combinator = ' '
  }
  return steps
}

function matchesSimple(element: FakeElement, simple: Simple): boolean {
  if (simple.tag && element.localName !== simple.tag) return false
  if (simple.id && element.id !== simple.id) return false
  for (const name of simple.classes) if (!element.classList.contains(name)) return false
  for (const attr of simple.attrs) {
    const value = element.getAttribute(attr.name)
    if (value === null || (attr.value !== null && value !== attr.value)) return false
  }
  if (simple.checked) {
    const box = element as FakeHTMLElement
    if (!(box.checked || box.selected)) return false
  }
  return simple.not.every((one) => !matchesSimple(element, one))
}

function matchesChain(element: FakeElement, steps: Step[]): boolean {
  const last = steps[steps.length - 1]
  if (!last || !matchesSimple(element, last.simple)) return false
  if (steps.length === 1) return true
  const rest = steps.slice(0, -1)
  if (last.combinator === '>') {
    const parent = element.parentElement
    return parent !== null && matchesChain(parent, rest)
  }
  for (let at = element.parentElement; at; at = at.parentElement) if (matchesChain(at, rest)) return true
  return false
}

function queryAll(root: FakeNode, selector: string): FakeElement[] {
  const chains = selector.split(',').map((one) => parseChain(one.trim()))
  const found: FakeElement[] = []
  const walk = (node: FakeNode) => {
    for (const kid of node._kids) {
      if (kid instanceof FakeElement && chains.some((chain) => matchesChain(kid, chain))) found.push(kid)
      walk(kid)
    }
  }
  walk(root)
  return found
}

function serialize(node: FakeNode): string {
  if (node instanceof FakeText) return node.data
  if (node instanceof FakeComment) return `<!--${node.data}-->`
  if (node instanceof FakeElement) {
    const attrs = node.attributes.map(({ name, value }) => ` ${name}="${value.replaceAll('"', '&quot;')}"`).join('')
    return `<${node.localName}${attrs}>${node._kids.map(serialize).join('')}</${node.localName}>`
  }
  return node._kids.map(serialize).join('')
}

/* ---------------------------------------------------------------- window */

class FakeStorage {
  #items = new Map<string, string>()
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, String(value))
  }
  removeItem(key: string): void {
    this.#items.delete(key)
  }
  clear(): void {
    this.#items.clear()
  }
}

class Quiet {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return []
  }
}

const fakeDocument = new FakeDocument()
const fakeWindow = Object.assign(new Target(), {
  document: fakeDocument,
  innerWidth: 1440,
  innerHeight: 900,
  scrollX: 0,
  scrollY: 0,
  devicePixelRatio: 1,
})

/** The address the screens think they are at: `location.host` is printed into links. */
export const fakeLocation = {
  href: 'http://127.0.0.1:4100/admin',
  origin: 'http://127.0.0.1:4100',
  protocol: 'http:',
  host: '127.0.0.1:4100',
  hostname: '127.0.0.1',
  port: '4100',
  pathname: '/admin',
  search: '',
  hash: '',
  assign() {},
  replace() {},
  reload() {},
}

let installed = false

/**
 * Installs the document on globalThis (once per process) and the hooks that
 * compile the web app's components for it. `stubs` maps a specifier to a
 * module URL that stands in for it.
 */
export function installDom(stubs: Record<string, string> = {}): void {
  if (installed) return
  installed = true
  const root = path.resolve(import.meta.dirname, '..')
  register(new URL('./_svelte-hooks.mjs', import.meta.url), { data: { root, stubs } })
  const frame = (run: FrameRequestCallback): number => setTimeout(() => run(performance.now()), 0) as unknown as number
  const globals: Record<string, unknown> = {
    window: fakeWindow,
    document: fakeDocument,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    HTMLTemplateElement: FakeHTMLElement,
    HTMLInputElement: FakeHTMLElement,
    // Class checks only (`instanceof`): nothing here is ever one of these.
    HTMLMediaElement: class extends FakeHTMLElement {},
    HTMLSelectElement: class extends FakeHTMLElement {},
    HTMLOptionElement: class extends FakeHTMLElement {},
    HTMLTextAreaElement: class extends FakeHTMLElement {},
    HTMLAnchorElement: class extends FakeHTMLElement {},
    Text: FakeText,
    Comment: FakeComment,
    DocumentFragment: FakeFragment,
    Document: FakeDocument,
    location: fakeLocation,
    history: { state: null, pushState() {}, replaceState() {}, back() {} },
    localStorage: new FakeStorage(),
    sessionStorage: new FakeStorage(),
    ResizeObserver: Quiet,
    MutationObserver: Quiet,
    IntersectionObserver: Quiet,
    requestAnimationFrame: frame,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    requestIdleCallback: frame,
    cancelIdleCallback: (id: number) => clearTimeout(id),
    getComputedStyle: (element: FakeElement) => element.style,
    matchMedia: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    getSelection: () => null,
    scrollTo: () => {},
  }
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
    if (!(name in fakeWindow)) Object.defineProperty(fakeWindow, name, { configurable: true, writable: true, value })
  }
  // The window's own timers and fetch are the process's: a screen that asks
  // `window.setInterval` gets the one the test can see stop.
  for (const name of ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'navigator', 'performance', 'Event', 'CustomEvent', 'EventTarget', 'URL', 'URLSearchParams', 'Intl']) {
    Object.defineProperty(fakeWindow, name, { configurable: true, get: () => (globalThis as Record<string, unknown>)[name] })
  }
  Object.defineProperty(fakeWindow, 'fetch', { configurable: true, get: () => globalThis.fetch })
  Object.defineProperty(fakeWindow, 'location', { configurable: true, value: fakeLocation })
  ;(globalThis as Record<string, unknown>).__COLLOQ_VERSION__ = '0.0.0-test'
}

export type { FakeElement }
