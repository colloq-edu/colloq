/**
 * Файл .ipynb: прочитать и записать.
 *
 * Тетради комнаты — файлы, и это единственное место, где известно, как они
 * выглядят на диске. Разбор был раньше в github.ts (импорт из репозитория),
 * запись — в publish/notebook.ts (выгрузка опубликованного шага); обе половины
 * жили порознь и не знали друг о друге. Разошлись бы они молча: файл,
 * записанный одной и прочитанный другой, потерял бы ровно то, о чём они не
 * договорились.
 *
 * Формат — nbformat 4.5, тот же, что пишет сам Jupyter. Расхождений с ним два,
 * и оба намеренные:
 *
 * **Выводы не пишутся.** Тетрадь без них открывается везде и весит килобайты; с
 * ними — мегабайты base64 в файле, который несут к себе, чтобы запустить
 * заново. Тот же довод, что и у выгрузки публикации, и он же означает, что
 * файл на диске — это ИСХОДНИК тетради, а не её снимок.
 *
 * **`source` — массив строк с сохранёнными переводами.** Так пишет Jupyter, и
 * так diff файла в git читается построчно, а не одной строкой на всю ячейку.
 */
import type { CellType } from './notebook'

export interface FlatCell {
  type: CellType
  source: string
}

interface RawCell {
  cell_type?: unknown
  source?: unknown
}

/** Jupyter пишет `source` то строкой, то массивом строк — по настроению. */
function sourceText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((line) => (typeof line === 'string' ? line : '')).join('')
  }
  return ''
}

/**
 * Ячейки из .ipynb.
 *
 * `raw` становится markdown: в курсовых тетрадях это проза, а тип ячейки,
 * который продукт не умеет рисовать, иначе исчез бы молча — потерять текст
 * преподавателя хуже, чем показать его не тем шрифтом.
 *
 * Пустые ячейки в конце выбрасываются: это след редактора, который файл
 * сохранял, а не то, что кто-то написал.
 */
export function readIpynb(json: unknown): FlatCell[] {
  const doc = json as { cells?: unknown } | null
  const cells = Array.isArray(doc?.cells) ? doc.cells : []
  const out: FlatCell[] = []
  for (const raw of cells as RawCell[]) {
    const source = sourceText(raw?.source)
    if (source.trim().length === 0) continue
    out.push({ type: raw?.cell_type === 'code' ? 'code' : 'markdown', source })
  }
  return out
}

/** Разобрать текст файла. `null` — это не .ipynb, что бы ни говорило имя. */
export function parseIpynb(text: string): FlatCell[] | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (!json || typeof json !== 'object' || !Array.isArray((json as { cells?: unknown }).cells)) {
    return null
  }
  return readIpynb(json)
}

export function writeIpynb(cells: readonly FlatCell[]): string {
  const notebook = {
    cells: cells.map((cell) => ({
      cell_type: cell.type,
      metadata: {},
      source: cell.source.split(/(?<=\n)/),
      ...(cell.type === 'code' ? { execution_count: null, outputs: [] } : {}),
    })),
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
  return JSON.stringify(notebook, null, 1) + '\n'
}
