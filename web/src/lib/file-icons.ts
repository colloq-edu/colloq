/**
 * Какой значок у файла в дереве и на вкладке.
 *
 * До сих пор значок был один на всё: колонка из пятнадцати одинаковых листков,
 * в которой вид файла читался только по расширению в конце имени — то есть по
 * той части, которую первой съедает многоточие в узкой панели.
 *
 * Различаются не языки, а РОДЫ ЗАНЯТИЙ. Значок отвечает на вопрос «что я с этим
 * буду делать»: тетрадь открою и запущу, таблицу прочитаю пандасом, картинку
 * посмотрю, документ полистаю, а вот это скачаю и открою чем-то другим. Заводить
 * отдельный силуэт под .ts и .js незачем: с ними делают одно и то же.
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
  // Всё, что нельзя открыть здесь ничем: архив, модель, картинка неизвестного
  // формата. Коробка — это «лежит в комнате и уезжает отсюда целиком».
  if (kindOf(path) === 'binary') return 'box'
  return 'file'
}
