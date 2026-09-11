import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { parse } from 'svelte/compiler'
import type { MessageCatalog } from '../../shared/i18n-types.js'

/** Parse source only; never execute a component to discover its messages. */
function references(file: string): { imports: string[]; literals: Set<string> } {
  const source = fs.readFileSync(file, 'utf8')
  const imports: string[] = []
  const literals = new Set<string>()
  if (file.endsWith('.svelte')) {
    const ast = parse(source, { filename: file, modern: true })
    const visit = (node: any): void => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'Literal' && typeof node.value === 'string') literals.add(node.value)
      if (node.type === 'TemplateElement' && node.value?.cooked) literals.add(node.value.cooked)
      if (node.type === 'ImportDeclaration' && node.importKind !== 'type' &&
        (node.specifiers.length === 0 || node.specifiers.some((specifier: any) => specifier.importKind !== 'type'))) {
        imports.push(node.source.value)
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit)
        else if (value && typeof value === 'object') visit(value)
      }
    }
    visit(ast)
  } else {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) literals.add(node.text)
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.importClause
        const bindings = clause?.namedBindings
        const onlyTypes = clause?.isTypeOnly || (clause && !clause.name && bindings &&
          ts.isNamedImports(bindings) && bindings.elements.every((element) => element.isTypeOnly))
        if (!onlyTypes) imports.push(node.moduleSpecifier.text)
      }
      if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return { imports, literals }
}

function resolveImport(root: string, importer: string, name: string): string | null {
  const base = name.startsWith('@shared/') ? path.join(root, 'shared', name.slice(8))
    : name.startsWith('@/') ? path.join(root, 'web/src', name.slice(2))
      : name.startsWith('.') ? path.resolve(path.dirname(importer), name) : null
  if (!base) return null // vendor code has no Colloq display-copy keys
  for (const file of [base, base.replace(/\.js$/, '.ts'), base + '.ts', base + '.svelte', path.join(base, 'index.ts')]) {
    if (/\.(?:ts|svelte)$/.test(file) && fs.existsSync(file) && fs.statSync(file).isFile()) return file
  }
  return null
}

/** The initial router/form graph, excluding type-only and dynamic imports. */
export function collectEntryMessages(root: string, catalog: MessageCatalog): { messages: MessageCatalog; files: string[] } {
  const pending = [path.join(root, 'web/src/main.ts'), path.join(root, 'web/src/App.svelte')]
  const seen = new Set<string>()
  const words = new Set<string>()
  while (pending.length > 0) {
    const file = pending.pop()!
    if (seen.has(file) || /[/\\](?:i18n|i18n-runtime|i18n-browser)\.ts$/.test(file)) continue
    seen.add(file)
    const found = references(file)
    for (const word of found.literals) words.add(word)
    for (const name of found.imports) {
      const dependency = resolveImport(root, file, name)
      if (dependency) pending.push(dependency)
    }
  }
  // Concatenated families such as `room.mark.` + name must include every
  // member. Complete literal keys include copy stored in constants/objects,
  // not just strings directly passed to tr(). Unknown server errors already
  // arrive translated and intentionally pass through tr() unchanged.
  const prefixes = [...words].filter((word) => /^(?:common|room|admin|server|activity)\..*\.$/.test(word))
  const messages: MessageCatalog = {}
  for (const [key, pair] of Object.entries(catalog)) {
    if (key.startsWith('common.') || words.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) messages[key] = pair
  }
  return { messages, files: [...seen].sort() }
}
