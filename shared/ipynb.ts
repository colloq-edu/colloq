/**
 * Файл .ipynb: прочитать и записать.
 *
 * Тетради комнаты — файлы, и это единственное место, где известно, как они
 * выглядят на диске. Разбор был раньше в github.ts (импорт из репозитория),
 * запись — в publish/notebook.ts (выгрузка опубликованного шага); обе половины
 * жили порознь и не знали друг о друге. Разошлись бы они молча: файл,
 * записанный одной и прочитанный другой, потерял бы ровно то, о чём они не
 * договорились. И разошлись: половина из публикации ставила ячейкам `id`, а
 * половина из комнаты — нет, при том что обе объявляли одну и ту же схему 4.5,
 * которая его требует. Пишет теперь одна, `writeIpynb`; выгрузка публикации
 * зовёт её же (publish/notebook.ts · `notebookFrom`).
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
  /**
   * Идентификатор ячейки, если он у пишущего есть.
   *
   * Необязателен, потому что разбор его не возвращает: чужую тетрадь комната
   * заводит своими ячейками и своими идентификаторами. А вот при записи он
   * нужен всегда (см. `cellIdFor`), и тот, у кого он есть, обязан его донести —
   * иначе файл, переписанный после перестановки ячеек, поменяет им имена.
   */
  id?: string
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
 * сохранял, а не то, что кто-то написал. Пустые ПОСРЕДИ остаются, и это
 * важнее, чем кажется: заготовка «# Задание 1 → пустая ячейка для ответа →
 * # Задание 2 → …» состоит из них наполовину. Выбрасывать их все — значит
 * молча привезти в комнату одни условия без места под решение, а в лекции
 * (structure: host) завести ячейку обратно студенту нечем.
 */
export function readIpynb(json: unknown): FlatCell[] {
  const doc = json as { cells?: unknown } | null
  const cells = Array.isArray(doc?.cells) ? doc.cells : []
  const all: FlatCell[] = (cells as RawCell[]).map((raw) => ({
    type: raw?.cell_type === 'code' ? 'code' : 'markdown',
    source: sourceText(raw?.source),
  }))
  let end = all.length
  while (end > 0 && all[end - 1].source.trim().length === 0) end -= 1
  return all.slice(0, end)
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

/**
 * Идентификатор ячейки в том виде, в каком его принимает схема 4.5.
 *
 * `nbformat_minor: 5` требует `id` у каждой ячейки — без него `nbformat.read`
 * ругается MissingIDFieldWarning и дописывает свой, а `nbformat.validate`
 * (автопроверка, CI студента) просто падает. Схема разрешает
 * `^[a-zA-Z0-9-_]{1,64}$`: наши укладываются, но приходят они из документа
 * комнаты, то есть от кого угодно, — что не уложилось, заменяется на
 * порядковый номер.
 */
const ID_OK = /^[a-zA-Z0-9-_]{1,64}$/
const cellIdFor = (cell: FlatCell, index: number): string =>
  cell.id !== undefined && ID_OK.test(cell.id) ? cell.id : `cell-${index + 1}`

export function writeIpynb(cells: readonly FlatCell[]): string {
  const notebook = {
    cells: cells.map((cell, index) => ({
      id: cellIdFor(cell, index),
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
