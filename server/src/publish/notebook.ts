/**
 * Тетрадь публикации файлом .ipynb.
 *
 * Единственный способ унести код с собой целиком: в комнате экспорта нет
 * вовсе, а выделить мышью через несколько ячеек нельзя — каждая из них
 * отдельный редактор CodeMirror.
 *
 * Отдаётся последний шаг, то есть тетрадь на момент публикации. Выводы в файл
 * не кладутся: notebook без них открывается везде и весит килобайты, с ними —
 * мегабайты base64 в файле, который студент несёт к себе, чтобы запустить
 * заново, и первым делом всё равно нажмёт «Run».
 */
import { readStep, stepHeadings } from './store.js'

export function notebookOf(pub: string): string {
  const headings = stepHeadings(pub)
  const last = headings.at(-1)
  const step = last ? readStep(pub, last.seq) : null
  const cells = step?.cells ?? []
  const notebook = {
    cells: cells.map((cell) => ({
      cell_type: cell.type,
      metadata: {},
      // Массивом строк с сохранёнными переводами: так пишет сам Jupyter, и
      // diff такого файла в git читается построчно.
      source: cell.source.split(/(?<=\n)/),
      ...(cell.type === 'code' ? { execution_count: null, outputs: [] } : {}),
    })),
    metadata: {
      kernelspec: {
        display_name: 'Python 3',
        language: 'python',
        name: 'python3',
      },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }
  return JSON.stringify(notebook, null, 1)
}
