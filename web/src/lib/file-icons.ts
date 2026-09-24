/**
 * Which icon a file has in the tree and on the tab.
 *
 * Until now there was one icon for everything: a column of fifteen identical
 * sheets, in which the file type could be read only by the extension at the
 * end of the name — that is, by the part an ellipsis eats first in a narrow
 * panel.
 *
 * What differs is not languages but KINDS OF WORK. The icon answers the
 * question "what will I do with this": a notebook I will open and run, a table
 * I will read with pandas, an image I will look at, a document I will page
 * through, and this one I will download and open with something else. There
 * is no point in a separate silhouette for .ts and .js: people do the same
 * thing with both.
 */
import type { IconName } from '@/components/ui/Icon.svelte'
import { extOf, kindOf } from '@shared/paths'

const TABLE = new Set(['csv', 'tsv', 'xlsx', 'xls', 'parquet'])
const CONFIG = new Set(['json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env'])
const CODE = new Set([
  'py',
  'pyi',
  'sh',
  'bash',
  'zsh',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'sql',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'java',
  'go',
  'rs',
  'rb',
  'lua',
  'r',
  'jl',
])
const PROSE = new Set(['md', 'markdown', 'rst', 'txt', 'log', 'tex', 'bib'])

export function iconFor(path: string): IconName {
  const ext = extOf(path)
  if (ext === 'ipynb') return 'notebook'
  if (ext === 'pdf') return 'pdf'
  if (TABLE.has(ext)) return 'table'
  if (CONFIG.has(ext)) return 'braces'
  if (CODE.has(ext)) return 'code'
  if (PROSE.has(ext)) return 'text'
  if (kindOf(path) === 'image') return 'image'
  // Everything that cannot be opened here by anything: an archive, a model, an
  // image of an unknown format. The box means "lies in the room and leaves it
  // whole".
  if (kindOf(path) === 'binary') return 'box'
  return 'file'
}
