/**
 * Module hooks that let a test mount the panel's real screens in Node: a
 * `.svelte` file is compiled for the browser on import, a `.svelte.ts` rune
 * module the same way, the web app's aliases resolve to their folders, and
 * Svelte's own modules are taken in their browser build (the default one is
 * the server's, where `onMount` never runs). A stylesheet is an empty
 * module. A few files can be replaced by stubs (`stubs`, by their path in
 * the repository): pieces the screens draw that need a real browser, an
 * icon's raw SVG. A stub is matched by the file a specifier lands on, since
 * an alias may reach this hook already resolved by the TypeScript loader.
 *
 * Registered by tests/_admin-dom.mts; plain JavaScript because it runs in
 * the loader's own thread, before anything compiles TypeScript there.
 */
import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { compile, compileModule } from 'svelte/compiler'

let root = ''
/** @type {Map<string, string>} the stub's module URL, by the absolute path of the file it replaces */
let stubs = new Map()

/** @param {{ root: string; stubs?: Record<string, string> }} data */
export function initialize(data) {
  root = data.root
  stubs = new Map(Object.entries(data.stubs ?? {}).map(([file, url]) => [path.join(root, file), url]))
}

/** The file a web-app path names: as written, or with .ts, or its folder's index. */
function onDisk(file) {
  const tries = [file, `${file}.ts`, path.join(file, 'index.ts')]
  if (file.endsWith('.js')) tries.unshift(file.slice(0, -3) + '.ts')
  for (const one of tries) {
    if (existsSync(one) && statSync(one).isFile()) return one
  }
  return null
}

const BROWSER_PACKAGES = ['/node_modules/svelte/', '/node_modules/esm-env/']

export async function resolve(specifier, context, next) {
  let aliased = null
  if (specifier.startsWith('@/')) aliased = path.join(root, 'web/src', specifier.slice(2))
  else if (specifier.startsWith('@shared/')) aliased = path.join(root, 'shared', specifier.slice('@shared/'.length))
  else if (specifier.startsWith('file:')) aliased = fileURLToPath(specifier)
  else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    aliased = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier)
  }
  const file = aliased ? onDisk(aliased) : null
  if (file && stubs.has(file)) return { url: stubs.get(file), shortCircuit: true }
  if (file && !specifier.startsWith('.') && !specifier.startsWith('file:')) {
    return { url: pathToFileURL(file).href, shortCircuit: true }
  }
  const browser =
    specifier === 'svelte' ||
    specifier.startsWith('svelte/') ||
    specifier === 'esm-env' ||
    specifier.startsWith('esm-env/') ||
    BROWSER_PACKAGES.some((one) => context.parentURL?.includes(one))
  if (browser) return next(specifier, { ...context, conditions: ['browser', ...context.conditions] })
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
  if (url.endsWith('.svelte')) {
    const file = fileURLToPath(url)
    const source = await readFile(file, 'utf8')
    // `tree`: the elements are built by createElement, so the stand-in DOM
    // needs no HTML parser for the markup itself.
    const { js } = compile(source, { filename: file, generate: 'client', fragments: 'tree', css: 'external', dev: false })
    return { format: 'module', source: js.code, shortCircuit: true }
  }
  if (url.endsWith('.svelte.ts') || url.endsWith('.svelte.js')) {
    const file = fileURLToPath(url)
    let source = await readFile(file, 'utf8')
    if (file.endsWith('.ts')) {
      source = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText
    }
    const { js } = compileModule(source, { filename: file, generate: 'client', dev: false })
    return { format: 'module', source: js.code, shortCircuit: true }
  }
  return next(url, context)
}
